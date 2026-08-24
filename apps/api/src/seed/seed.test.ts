// Seed tests. The Fase 0 done criterion in spec 14 is "bisa login dengan semua
// role", so the seed is not a convenience script here, it is the thing that
// makes that criterion checkable. These tests run it and then log in as every
// account it claims to create.
import { describe, expect, test } from "bun:test";
import { createApp } from "../core/app";
import { createDbAdapter } from "../core/adapters/db";
import { nativeFetchApi } from "../testing/native-fetch";
import { DEMO_CABANG, DEMO_MITRA, DEMO_PASSWORD, DEMO_USERS, databaseBolehDemo, seedDemo } from "./demo";
import { seedKonfigurasiTambahan } from "./konfigurasi";
import { seedRbac } from "./rbac";
import { ROLE_CODES, PERMISSIONS, PERMISSIONS_BY_ROLE } from "../modules/auth";
import { entriTambahan } from "../modules/konfigurasi";

const db = createDbAdapter();

/** argon2 floor, so seeding seven accounts twice does not cost a second. */
const FAST = { memoryCost: 4096, timeCost: 1 } as const;

async function seedAll(): Promise<void> {
  await seedRbac(db);
  await seedKonfigurasiTambahan(db);
  await seedDemo(db, { passwordOptions: FAST });
}

describe("seedRbac", () => {
  test("creates every permission in the catalogue and every spec 2 role", async () => {
    await seedRbac(db);
    const perms = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM permission WHERE kode = ANY($1::text[])",
      [[...PERMISSIONS]],
    );
    expect(Number(perms[0]!.n)).toBe(PERMISSIONS.length);

    const roles = await db.query<{ kode: string }>(
      "SELECT kode FROM app_role WHERE kode = ANY($1::text[]) AND deleted_at IS NULL",
      [[...ROLE_CODES]],
    );
    expect(roles.map((r) => r.kode).sort()).toEqual([...ROLE_CODES].sort());
  });

  test("grants exactly the catalogue mapping, per role", async () => {
    await seedRbac(db);
    for (const role of ROLE_CODES) {
      const rows = await db.query<{ kode: string }>(
        `SELECT p.kode FROM role_permission rp
           JOIN app_role r ON r.id = rp.role_id
           JOIN permission p ON p.id = rp.permission_id
          WHERE r.kode = $1 AND r.deleted_at IS NULL`,
        [role],
      );
      expect(rows.map((r) => r.kode).sort()).toEqual([...PERMISSIONS_BY_ROLE[role]].sort());
    }
  });

  test("is idempotent: running it twice changes nothing", async () => {
    await seedRbac(db);
    const before = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM role_permission rp
         JOIN app_role r ON r.id = rp.role_id WHERE r.is_system`,
    );
    await seedRbac(db);
    const after = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM role_permission rp
         JOIN app_role r ON r.id = rp.role_id WHERE r.is_system`,
    );
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  test("revokes a grant that is no longer in the catalogue", async () => {
    // A stale grant is a privilege-escalation path, so the seed reconciles
    // rather than only inserting.
    await seedRbac(db);
    await db.query(
      `INSERT INTO permission (kode, grup, deskripsi) VALUES ('uji.hantu', 'uji', 'grant basi')
       ON CONFLICT (kode) DO NOTHING`,
    );
    await db.query(
      `INSERT INTO role_permission (role_id, permission_id)
       SELECT r.id, p.id FROM app_role r, permission p
        WHERE r.kode = 'MAKER' AND r.deleted_at IS NULL AND p.kode = 'uji.hantu'
       ON CONFLICT DO NOTHING`,
    );
    await seedRbac(db);
    const rows = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM role_permission rp
         JOIN app_role r ON r.id = rp.role_id
         JOIN permission p ON p.id = rp.permission_id
        WHERE r.kode = 'MAKER' AND p.kode = 'uji.hantu'`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

describe("seedKonfigurasiTambahan", () => {
  test("creates every capability key that has no migration", async () => {
    await seedKonfigurasiTambahan(db);
    for (const entri of entriTambahan()) {
      const rows = await db.query<{ nilai: string }>(
        `SELECT nilai FROM konfigurasi
          WHERE bumn_id IS NULL AND grup = $1 AND kunci = $2 AND deleted_at IS NULL`,
        [entri.grup, entri.kunci],
      );
      expect(rows).toHaveLength(1);
    }
  });

  test("never overwrites a value an operator changed", async () => {
    await seedKonfigurasiTambahan(db);
    await db.query(
      `UPDATE konfigurasi SET nilai = 'KOLEKTIF_HISTORIS'
        WHERE bumn_id IS NULL AND grup = 'akuntansi' AND kunci = 'mode_penyisihan'`,
    );
    await seedKonfigurasiTambahan(db);
    const rows = await db.query<{ nilai: string }>(
      `SELECT nilai FROM konfigurasi
        WHERE bumn_id IS NULL AND grup = 'akuntansi' AND kunci = 'mode_penyisihan' AND deleted_at IS NULL`,
    );
    expect(rows[0]!.nilai).toBe("KOLEKTIF_HISTORIS");
    // Put the shipped default back for the rest of the suite.
    await db.query(
      `UPDATE konfigurasi SET nilai = 'RATE_TABLE'
        WHERE bumn_id IS NULL AND grup = 'akuntansi' AND kunci = 'mode_penyisihan'`,
    );
  });
});

describe("demo accounts (spec 14: bisa login dengan semua role)", () => {
  test("creates one account per spec 2 role, plus the cross-branch Maker", async () => {
    await seedAll();
    const usernames = DEMO_USERS.map((u) => u.username);
    const rows = await db.query<{ username: string; role: string }>(
      `SELECT u.username, r.kode AS role
         FROM app_user u
         JOIN user_role ur ON ur.user_id = u.id
         JOIN app_role r ON r.id = ur.role_id
        WHERE u.username = ANY($1::text[]) AND u.deleted_at IS NULL`,
      [usernames],
    );
    expect(rows).toHaveLength(DEMO_USERS.length);
    for (const spec of DEMO_USERS) {
      const found = rows.find((r) => r.username === spec.username);
      expect(found?.role).toBe(spec.role);
    }
    // Every spec 2 role is covered, Auditor included.
    expect(new Set(rows.map((r) => r.role))).toEqual(new Set([...ROLE_CODES]));
  });

  test("every demo account can actually log in with the documented password", async () => {
    await seedAll();
    const { app } = createApp({ keyPrefix: `seedtest:${crypto.randomUUID().slice(0, 8)}` });
    const { Request: NativeRequest } = nativeFetchApi();

    for (const spec of DEMO_USERS) {
      const res = await app.fetch(
        new NativeRequest("http://localhost/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: spec.username, password: DEMO_PASSWORD }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: { role: string }; cabang: { kode: string } };
      expect(body.user.role).toBe(spec.role);
      expect(body.cabang.kode).toBe(spec.cabangKode);
    }
  }, 20_000);

  test("creates the head office plus the branches the demo needs on both sides", async () => {
    await seedAll();
    const rows = await db.query<{ kode: string; is_pusat: boolean }>(
      `SELECT c.kode, c.is_pusat FROM cabang c
         JOIN bumn b ON b.id = c.bumn_id
        WHERE b.kode = 'KRAS' AND c.deleted_at IS NULL ORDER BY c.kode`,
    );
    expect(rows.map((r) => r.kode)).toEqual(DEMO_CABANG.map((c) => c.kode));
    expect(rows.filter((r) => r.is_pusat)).toHaveLength(1);
  });

  test("creates a Mitra portal account (spec 4.9), verified and active", async () => {
    await seedAll();
    const rows = await db.query<{ email: string; aktif: boolean; verified: string | null }>(
      `SELECT p.email, p.aktif, p.verified_at::text AS verified
         FROM portal_akun_mitra p JOIN mitra m ON m.id = p.mitra_id
        WHERE m.kode_mitra = $1 AND p.deleted_at IS NULL`,
      [DEMO_MITRA.kodeMitra],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe(DEMO_MITRA.email);
    expect(rows[0]!.aktif).toBe(true);
    expect(rows[0]!.verified).not.toBeNull();
  });

  test("is idempotent: seeding twice leaves one row per account", async () => {
    await seedAll();
    await seedAll();
    const rows = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM app_user WHERE username = ANY($1::text[]) AND deleted_at IS NULL",
      [DEMO_USERS.map((u) => u.username)],
    );
    expect(Number(rows[0]!.n)).toBe(DEMO_USERS.length);
  }, 20_000);

  test("a demo account holds exactly one role, so the authorisation demo is honest", async () => {
    await seedAll();
    const rows = await db.query<{ username: string; n: string }>(
      `SELECT u.username, count(*)::text AS n
         FROM app_user u JOIN user_role ur ON ur.user_id = u.id
        WHERE u.username = ANY($1::text[]) AND u.deleted_at IS NULL
        GROUP BY u.username`,
      [DEMO_USERS.map((u) => u.username)],
    );
    for (const row of rows) expect(Number(row.n)).toBe(1);
  });

  test("the demo password is stored as an argon2id hash, never as plaintext", async () => {
    await seedAll();
    const rows = await db.query<{ password_hash: string }>(
      "SELECT password_hash FROM app_user WHERE username = 'auditor' AND deleted_at IS NULL",
    );
    expect(rows[0]!.password_hash).toStartWith("$argon2id$");
    expect(rows[0]!.password_hash).not.toContain(DEMO_PASSWORD);
  });
});

describe("demo seed refuses anything that is not obviously disposable", () => {
  test("only a _dev / _test / _local / _demo database qualifies", () => {
    expect(databaseBolehDemo("postgres://localhost:5432/tjsl_test")).toBe(true);
    expect(databaseBolehDemo("postgres://localhost:5432/tjsl_dev")).toBe(true);
    expect(databaseBolehDemo("postgres://u:p@host/tjsl_local")).toBe(true);
    expect(databaseBolehDemo("postgres://u:p@host/tjsl_demo")).toBe(true);
    // Production shapes, including the compose default.
    expect(databaseBolehDemo("postgres://tjsl:secret@postgres:5432/tjsl")).toBe(false);
    expect(databaseBolehDemo("postgres://u:p@host/tjsl_prod")).toBe(false);
    expect(databaseBolehDemo("postgres://u:p@host/production")).toBe(false);
    expect(databaseBolehDemo("postgres://u:p@host/tjsl?sslmode=require")).toBe(false);
  });

  test("seedDemo throws rather than writing public credentials to such a database", async () => {
    // The credentials in demo.ts are printed in SEED.md. Writing them to a
    // real database hands Admin Pusat to anyone who can read the repo.
    await expect(
      seedDemo(db, { passwordOptions: FAST, targetUrl: "postgres://tjsl:secret@postgres:5432/tjsl" }),
    ).rejects.toThrow(/Menolak menulis akun demo/);
  });

  test("refuses to overwrite an account it does not own, instead of resetting its password", async () => {
    // `maker` is an ordinary word: a real deployment can already have one.
    // Re-running the seed used to reset that person's password to the public
    // demo password and replace their roles.
    await seedAll();
    const kode = `RL${crypto.randomUUID().slice(0, 6)}`;
    const bumn = await db.query<{ id: string }>(
      "INSERT INTO bumn (kode, nama) VALUES ($1, $1) RETURNING id::text AS id",
      [kode],
    );
    const cabang = await db.query<{ id: string }>(
      "INSERT INTO cabang (bumn_id, kode, nama) VALUES ($1, '01', 'Cabang Nyata') RETURNING id::text AS id",
      [bumn[0]!.id],
    );
    // Take over the `checker` username with a NON-demo email, the way a real
    // account would look.
    expect(cabang[0]!.id).toBeDefined();
    await db.query(
      `UPDATE app_user SET email = $1 WHERE lower(username) = 'checker' AND deleted_at IS NULL`,
      [`orang.nyata.${kode}@perusahaan.co.id`],
    );
    try {
      await expect(seedDemo(db, { passwordOptions: FAST })).rejects.toThrow(/bukan milik seed demo/);
    } finally {
      await db.query(
        `UPDATE app_user SET email = 'checker@demo.tjsl.local'
          WHERE lower(username) = 'checker' AND deleted_at IS NULL`,
      );
    }
  }, 20_000);
});
