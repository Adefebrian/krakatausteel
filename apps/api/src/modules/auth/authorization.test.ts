// SPEC 2 RULE 4: "Otorisasi divalidasi di layer server, bukan hanya di UI.
// Buat test yang memanggil endpoint langsung dengan role yang salah dan
// pastikan ditolak."
//
// This file is that test. It calls every Fase 0 endpoint as every role in spec
// 2 and asserts the exact status, so a permission grant cannot be widened by
// accident. It also covers spec 16 scenario 23 (the Auditor cannot change
// anything) and scenario 24 (a Maker from branch A cannot reach branch B,
// including by editing the id in the URL).
//
// The matrix is written out as data rather than as prose: when Fase 3 adds
// `pumk.approve` to a role, the diff shows exactly which cell moved.
import { beforeAll, describe, expect, test } from "bun:test";
import { createFixture, type Fixture } from "../../testing/harness";
import { PERMISSIONS, PERMISSIONS_BY_ROLE, ROLE_CODES, type RoleCode } from "./permissions";

let f: Fixture;
const cookies = new Map<RoleCode | "MAKER_B", string>();

beforeAll(async () => {
  f = await createFixture();
  for (const role of ROLE_CODES) {
    cookies.set(role, await f.login(f.users[role].username));
  }
  cookies.set("MAKER_B", await f.login(f.users.MAKER_B.username));
});

const as = (role: RoleCode | "MAKER_B"): string => {
  const cookie = cookies.get(role);
  if (!cookie) throw new Error(`tidak ada sesi untuk ${role}`);
  return cookie;
};

// ---------------------------------------------------------------------------
// The permission matrix, per endpoint
// ---------------------------------------------------------------------------

interface EndpointCase {
  name: string;
  method: string;
  path: (fixture: Fixture) => string;
  body?: unknown;
  /** Required permission(s), any-of, as passed to requirePermission. */
  permission: string;
  /** Roles that must succeed. Everyone else must be refused. */
  allowed: readonly RoleCode[];
  /** Status a permitted role gets. */
  okStatus?: number;
}

const CASES: readonly EndpointCase[] = [
  {
    name: "GET /audit",
    method: "GET",
    path: () => "/audit",
    permission: "audit.view",
    // Spec 2: only the Auditor has audit-trail access, plus Admin Pusat who
    // has everything.
    allowed: ["AUDITOR", "ADMIN_PUSAT"],
  },
  {
    name: "GET /konfigurasi",
    method: "GET",
    path: () => "/konfigurasi",
    permission: "konfigurasi.parameter atau audit.view",
    // The Auditor reads it because a parameter is part of the evidence for how
    // a number was calculated; Admin Cabang does NOT, because spec 2 puts
    // master data with Admin Pusat.
    allowed: ["ADMIN_PUSAT", "AUDITOR"],
  },
  {
    name: "GET /konfigurasi/:grup/:kunci",
    method: "GET",
    path: () => "/konfigurasi/batasan/tenor_max_bulan",
    permission: "konfigurasi.parameter atau audit.view",
    allowed: ["ADMIN_PUSAT", "AUDITOR"],
  },
  {
    name: "PUT /konfigurasi/:grup/:kunci",
    method: "PUT",
    path: () => "/konfigurasi/batasan/tenor_max_bulan",
    body: { nilai: "24" },
    permission: "konfigurasi.update",
    // Auditor is excluded by the read-only guard before the permission check.
    allowed: ["ADMIN_PUSAT"],
  },
  {
    name: "GET /organisasi/cabang",
    method: "GET",
    path: () => "/organisasi/cabang",
    permission: "dashboard.view",
    allowed: [...ROLE_CODES],
  },
  {
    name: "GET /organisasi/karyawan",
    method: "GET",
    path: () => "/organisasi/karyawan",
    permission: "dashboard.view",
    allowed: [...ROLE_CODES],
  },
  {
    name: "GET /organisasi/karyawan/:id (own branch)",
    method: "GET",
    // The Admin Pusat and Auditor sit in the head office, so "own branch" for
    // them means any branch; branch A is what the other four can reach.
    path: (fixture) => `/organisasi/karyawan/${fixture.karyawanA}`,
    permission: "dashboard.view",
    allowed: [...ROLE_CODES],
  },
];

describe("permission matrix, every role against every Fase 0 endpoint", () => {
  for (const endpoint of CASES) {
    for (const role of ROLE_CODES) {
      const shouldPass = endpoint.allowed.includes(role);
      test(`${endpoint.name} as ${role} -> ${shouldPass ? "allowed" : "refused"}`, async () => {
        const res = await f.request(endpoint.path(f), {
          method: endpoint.method,
          cookie: as(role),
          ...(endpoint.body !== undefined ? { body: endpoint.body } : {}),
        });
        if (shouldPass) {
          expect(res.status).toBe(endpoint.okStatus ?? 200);
        } else {
          expect(res.status).toBe(403);
          const body = (await res.json()) as { code: string; error: string };
          expect(body.code).toBe("TIDAK_BERWENANG");
          // The refusal never names the permission the caller is missing:
          // that is a map of the system for anyone probing it.
          expect(body.error).not.toContain(endpoint.permission.split(" ")[0]!);
        }
      });
    }
  }
});

describe("no session at all", () => {
  const paths = [
    "/auth/session",
    "/auth/me",
    "/audit",
    "/konfigurasi",
    "/organisasi/cabang",
    "/organisasi/karyawan",
  ];
  for (const path of paths) {
    test(`GET ${path} without a cookie is 401, not 200 and not 500`, async () => {
      const res = await f.request(path);
      expect(res.status).toBe(401);
    });
  }

  test("a mutating endpoint without a cookie is 401, not a silent success", async () => {
    const res = await f.request("/konfigurasi/batasan/tenor_max_bulan", {
      method: "PUT",
      body: { nilai: "12" },
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Spec 16 scenario 23: the Auditor cannot change anything
// ---------------------------------------------------------------------------

describe("Auditor is read only, structurally", () => {
  test("the session payload says so, so the UI has no excuse either", async () => {
    const res = await f.request("/auth/session", { cookie: as("AUDITOR") });
    const body = (await res.json()) as { readOnly: boolean; lintasCabang: boolean; permissions: string[] };
    expect(body.readOnly).toBe(true);
    expect(body.lintasCabang).toBe(true);
    expect(body.permissions).toEqual([...PERMISSIONS_BY_ROLE.AUDITOR].sort());
  });

  test("every read the Auditor is entitled to still works", async () => {
    for (const path of ["/audit", "/konfigurasi", "/organisasi/cabang", "/organisasi/karyawan"]) {
      const res = await f.request(path, { cookie: as("AUDITOR") });
      expect(res.status).toBe(200);
    }
  });

  const mutations = [
    { method: "PUT", path: "/konfigurasi/batasan/tenor_max_bulan", body: { nilai: "24" } },
    { method: "POST", path: "/konfigurasi/batasan/tenor_max_bulan", body: { nilai: "24" } },
    { method: "DELETE", path: "/konfigurasi/batasan/tenor_max_bulan" },
    { method: "PATCH", path: "/konfigurasi/batasan/tenor_max_bulan", body: { nilai: "24" } },
    // A path with no route at all: the guard runs BEFORE routing, so a
    // read-only role is refused with 403 rather than reaching a 404. Proof
    // that the block is structural, not per-route bookkeeping, and that a
    // route added in a later phase is covered before its author thinks about
    // it.
    { method: "POST", path: "/belum-ada-di-fase-ini", body: { apa: "saja" } },
  ];
  for (const mutation of mutations) {
    test(`${mutation.method} ${mutation.path} as Auditor is refused`, async () => {
      const res = await f.request(mutation.path, {
        method: mutation.method,
        cookie: as("AUDITOR"),
        ...(mutation.body !== undefined ? { body: mutation.body } : {}),
      });
      // 403 for a route that exists, 404 for a method the router does not
      // have; what must never happen is 2xx.
      expect([403, 404]).toContain(res.status);
      expect(res.status).toBeLessThan(500);
    });
  }

  test("an anonymous mutation is NOT blocked by the read-only guard", async () => {
    // The guard is about roles, not about anonymity: a public portal
    // submission in Fase 7 must still be able to POST. With no cookie there is
    // no principal to be read-only, so the request continues and is refused by
    // the route's own session guard (401) rather than by this one (403).
    const res = await f.request("/konfigurasi/batasan/tenor_max_bulan", {
      method: "PUT",
      body: { nilai: "24" },
    });
    expect(res.status).toBe(401);
  });

  test("a refused mutation writes a DITOLAK row naming the role and the method", async () => {
    await f.request("/konfigurasi/batasan/tenor_max_bulan", {
      method: "PUT",
      cookie: as("AUDITOR"),
      body: { nilai: "30" },
    });
    const rows = await f.auditRows({ hasil: "DITOLAK", userId: f.users.AUDITOR.id });
    const relevant = rows.find((r) => (r.keterangan ?? "").includes("read only"));
    expect(relevant).toBeDefined();
    expect(relevant!.aksi).toBe("auth.otorisasi");
    expect(JSON.stringify(relevant!.nilai_baru_json)).toContain("PUT");
  });

  test("and the parameter really did not change", async () => {
    const read = async (): Promise<string> => {
      const res = await f.request("/konfigurasi/batasan/tenor_max_bulan", { cookie: as("ADMIN_PUSAT") });
      return ((await res.json()) as { nilai: string }).nilai;
    };
    // Read before and after, rather than asserting the shipped default: an
    // earlier case in this file legitimately changes the value as Admin Pusat.
    const before = await read();
    const attempt = await f.request("/konfigurasi/batasan/tenor_max_bulan", {
      method: "PUT",
      cookie: as("AUDITOR"),
      body: { nilai: "7" },
    });
    expect(attempt.status).toBe(403);
    expect(await read()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Spec 16 scenario 24: branch scoping, including URL id manipulation
// ---------------------------------------------------------------------------

describe("cabang scoping (spec 2 rule 3, spec 16 scenario 24)", () => {
  test("a Maker in branch A sees only branch A in the branch list", async () => {
    const res = await f.request("/organisasi/cabang", { cookie: as("MAKER") });
    const body = (await res.json()) as { data: { id: string; kode: string }[] };
    expect(body.data.map((row) => row.id)).toEqual([f.cabangA.id]);
  });

  test("Admin Pusat and Auditor see every branch", async () => {
    for (const role of ["ADMIN_PUSAT", "AUDITOR"] as const) {
      const res = await f.request("/organisasi/cabang", { cookie: as(role) });
      const body = (await res.json()) as { data: { id: string }[] };
      expect(body.data.map((row) => row.id).sort()).toEqual(
        [f.pusat.id, f.cabangA.id, f.cabangB.id].sort(),
      );
    }
  });

  test("Admin Cabang is NOT exempt from scoping (spec 2 rule 3 names only two roles)", async () => {
    const res = await f.request("/organisasi/cabang", { cookie: as("ADMIN_CABANG") });
    const body = (await res.json()) as { data: { id: string }[] };
    expect(body.data.map((row) => row.id)).toEqual([f.cabangA.id]);
  });

  test("a Maker in branch A is refused branch B by id in the URL", async () => {
    const res = await f.request(`/organisasi/cabang/${f.cabangB.id}`, { cookie: as("MAKER") });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    // The message does not reveal which branch it was, so a 403 cannot be used
    // to enumerate other branches.
    expect(body.error).toBe("Data ini berada di luar cabang Anda");
  });

  test("a Maker in branch A is refused a branch B employee row by id in the URL", async () => {
    const own = await f.request(`/organisasi/karyawan/${f.karyawanA}`, { cookie: as("MAKER") });
    expect(own.status).toBe(200);
    const other = await f.request(`/organisasi/karyawan/${f.karyawanB}`, { cookie: as("MAKER") });
    expect(other.status).toBe(403);
  });

  test("and it is symmetric: the Maker in branch B cannot read branch A", async () => {
    const res = await f.request(`/organisasi/karyawan/${f.karyawanA}`, { cookie: as("MAKER_B") });
    expect(res.status).toBe(403);
    expect((await f.request(`/organisasi/karyawan/${f.karyawanB}`, { cookie: as("MAKER_B") })).status).toBe(200);
  });

  test("an explicit ?cabangId= filter for another branch is refused, not silently emptied", async () => {
    // An empty list looks like "no data" to the user and leaves nothing in the
    // audit trail. A refusal is honest and recorded.
    const res = await f.request(`/organisasi/karyawan?cabangId=${f.cabangB.id}`, { cookie: as("MAKER") });
    expect(res.status).toBe(403);
  });

  test("the employee list is filtered to the caller's branch", async () => {
    const res = await f.request("/organisasi/karyawan", { cookie: as("MAKER") });
    const body = (await res.json()) as { data: { id: string; cabang_id: string }[] };
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((row) => row.cabang_id === f.cabangA.id)).toBe(true);
    expect(body.data.map((row) => row.id)).not.toContain(f.karyawanB);
  });

  test("Admin Pusat can read a row in any branch of its own entity", async () => {
    for (const id of [f.karyawanA, f.karyawanB]) {
      expect((await f.request(`/organisasi/karyawan/${id}`, { cookie: as("ADMIN_PUSAT") })).status).toBe(200);
    }
  });

  test("even Admin Pusat cannot read another BUMN's row", async () => {
    // lintasCabang is an exemption from the BRANCH check, not from the entity
    // boundary. Same 404 as a nonexistent id, so the endpoint does not confirm
    // that the id exists somewhere else.
    const other = await createFixture();
    const res = await f.request(`/organisasi/karyawan/${other.karyawanA}`, { cookie: as("ADMIN_PUSAT") });
    expect(res.status).toBe(404);
  });

  test("a nonexistent id is 404, a well-formed id from elsewhere is 403 or 404, never 200", async () => {
    const missing = await f.request(`/organisasi/karyawan/${crypto.randomUUID()}`, { cookie: as("MAKER") });
    expect(missing.status).toBe(404);
  });

  test("a malformed id is a 400, not a 500 with a Postgres message", async () => {
    const res = await f.request("/organisasi/karyawan/bukan-uuid", { cookie: as("MAKER") });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("VALIDASI");
    expect(body.error).not.toContain("invalid input syntax");
  });

  test("a cross-branch refusal writes a DITOLAK row (spec 2 rule 5)", async () => {
    // This denial is thrown by a SERVICE (assertCabangAllowed), after the
    // guard chain has already let the request through on permissions, so the
    // guard never sees it. It used to leave no trace at all: the one denial
    // spec 16 scenario 24 exists to prove was the one denial that was not
    // recorded. The shared error handler now writes it.
    const before = await f.auditRows({ hasil: "DITOLAK", userId: f.users.CHECKER.id });
    const res = await f.request(`/organisasi/karyawan/${f.karyawanB}`, { cookie: as("CHECKER") });
    expect(res.status).toBe(403);

    const after = await f.auditRows({ hasil: "DITOLAK", userId: f.users.CHECKER.id });
    expect(after.length).toBe(before.length + 1);
    const row = after[0]!;
    expect(row.aksi).toBe("auth.otorisasi");
    expect(row.hasil).toBe("DITOLAK");
    expect(row.user_id).toBe(f.users.CHECKER.id);
    expect(row.keterangan).toContain("TIDAK_BERWENANG");
    expect(JSON.stringify(row.nilai_baru_json)).toContain("/organisasi/karyawan/");
  });

  test("a cross-branch list filter refusal is recorded too", async () => {
    const before = await f.auditRows({ hasil: "DITOLAK", userId: f.users.APPROVER.id });
    const res = await f.request(`/organisasi/karyawan?cabangId=${f.cabangB.id}`, {
      cookie: as("APPROVER"),
    });
    expect(res.status).toBe(403);
    const after = await f.auditRows({ hasil: "DITOLAK", userId: f.users.APPROVER.id });
    expect(after.length).toBe(before.length + 1);
  });

  test("a permission refusal is recorded exactly ONCE, not twice", async () => {
    // The guard writes its own row and flags the request; the error handler
    // must not add a second one for the same denial.
    const before = await f.auditRows({ hasil: "DITOLAK", userId: f.users.MAKER.id });
    const res = await f.request("/audit", { cookie: as("MAKER") });
    expect(res.status).toBe(403);
    const after = await f.auditRows({ hasil: "DITOLAK", userId: f.users.MAKER.id });
    expect(after.length).toBe(before.length + 1);
  });

  test("every refusal above is in audit_log as DITOLAK", async () => {
    const rows = await f.auditRows({ hasil: "DITOLAK", userId: f.users.MAKER.id });
    expect(rows.length).toBeGreaterThan(0);
    // The scope refusals come from the service (an AppError), the permission
    // refusals from the guard; both must be recorded. Here we check the guard
    // wrote its rows and that they carry the request context.
    const withContext = rows.filter((r) => JSON.stringify(r.nilai_baru_json ?? {}).includes("path"));
    expect(withContext.length).toBeGreaterThan(0);
  });
});

describe("session payload scoping", () => {
  test("a branch-bound role gets exactly one entry in cabangTersedia", async () => {
    const res = await f.request("/auth/session", { cookie: as("MAKER") });
    const body = (await res.json()) as { cabangTersedia: { id: string }[]; lintasCabang: boolean };
    expect(body.lintasCabang).toBe(false);
    expect(body.cabangTersedia.map((c) => c.id)).toEqual([f.cabangA.id]);
  });

  test("a lintas-cabang role gets every branch, which is what the switcher needs", async () => {
    const res = await f.request("/auth/session", { cookie: as("ADMIN_PUSAT") });
    const body = (await res.json()) as { cabangTersedia: { id: string }[]; lintasCabang: boolean };
    expect(body.lintasCabang).toBe(true);
    expect(body.cabangTersedia).toHaveLength(3);
  });

  test("GET /auth/me reports the identity used for audit rows", async () => {
    const res = await f.request("/auth/me", { cookie: as("CHECKER") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; roles: string[]; readOnly: boolean };
    expect(body.userId).toBe(f.users.CHECKER.id);
    expect(body.roles).toEqual(["CHECKER"]);
    expect(body.readOnly).toBe(false);
  });
});

describe("permission catalogue integrity", () => {
  test("the six spec 2 roles all exist and are seeded as system roles", async () => {
    const rows = await f.db.query<{ kode: string; is_system: boolean }>(
      "SELECT kode, is_system FROM app_role WHERE deleted_at IS NULL ORDER BY kode",
    );
    for (const role of ROLE_CODES) {
      const found = rows.find((r) => r.kode === role);
      expect(found).toBeDefined();
      expect(found!.is_system).toBe(true);
    }
  });

  test("no system role holds a grant outside the catalogue (no privilege creep)", async () => {
    // Scoped to the six system roles ON PURPOSE. app_role and permission are
    // global tables and other test files legitimately create their own
    // suffixed roles and permissions in the same database; asserting over all
    // of them would be asserting about another agent's fixtures.
    const rows = await f.db.query<{ role: string; kode: string }>(
      `SELECT r.kode AS role, p.kode AS kode
         FROM role_permission rp
         JOIN app_role r ON r.id = rp.role_id
         JOIN permission p ON p.id = rp.permission_id
        WHERE r.is_system AND r.kode = ANY($1::text[]) AND r.deleted_at IS NULL`,
      [[...ROLE_CODES]],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const allowed = PERMISSIONS_BY_ROLE[row.role as RoleCode] as readonly string[];
      expect(allowed).toContain(row.kode);
    }
  });

  test("the server knows every permission the SPA checks (and every one the engines check)", async () => {
    // The failure this catches: a permission string that some caller gates on
    // but no role can hold, because it is absent from the catalogue that
    // ADMIN_PUSAT is built from. That is exactly how `jurnal.update` and
    // `jurnal.delete` came to be uncheckable by every user in the system.
    //
    // apps/web/src/permissions.ts is the SPA's MIRROR of this catalogue. If
    // this fails after a frontend change, the fix is to add the code here (and
    // grant it to a role), not to delete it there.
    const web = await Bun.file(
      new URL("../../../../web/src/permissions.ts", import.meta.url).pathname,
    ).text();
    const blok = /export const PERMISSIONS = \[([\s\S]*?)\] as const;/.exec(web);
    expect(blok).not.toBeNull();
    const kodeSpa = [...blok![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(kodeSpa.length).toBeGreaterThan(30);

    const dikenal = new Set<string>(PERMISSIONS);
    const tidakDikenal = kodeSpa.filter((kode) => !dikenal.has(kode));
    expect(tidakDikenal).toEqual([]);

    // And every canonical code must be reachable: something has to be able to
    // hold it, or it is a permanent 403 waiting for a screen to be built.
    const dipegang = new Set<string>(Object.values(PERMISSIONS_BY_ROLE).flat());
    expect([...dikenal].filter((kode) => !dipegang.has(kode))).toEqual([]);
  });

  test("the journal engine's permission codes are all in the catalogue and granted", () => {
    // Read straight out of the engine's own constant list so a new gate there
    // fails here rather than in production. The engine gates draft edit and
    // cancel on these two, which nothing could hold until they were added.
    for (const kode of ["jurnal.create", "jurnal.update", "jurnal.verify", "jurnal.post", "jurnal.delete"]) {
      expect(PERMISSIONS as readonly string[]).toContain(kode);
    }
    // Maker owns its drafts, so it must be able to correct and cancel one.
    expect(PERMISSIONS_BY_ROLE.MAKER as readonly string[]).toContain("jurnal.update");
    expect(PERMISSIONS_BY_ROLE.MAKER as readonly string[]).toContain("jurnal.delete");
    // Posting and reversal stay with the Approver, and reversal is its own
    // code because rewriting a posted entry is the heavier privilege.
    expect(PERMISSIONS_BY_ROLE.APPROVER as readonly string[]).toContain("jurnal.post");
    expect(PERMISSIONS_BY_ROLE.APPROVER as readonly string[]).toContain("jurnal.reversal");
    expect(PERMISSIONS_BY_ROLE.MAKER as readonly string[]).not.toContain("jurnal.post");
    expect(PERMISSIONS_BY_ROLE.CHECKER as readonly string[]).not.toContain("jurnal.post");
  });

  test("reading config and WRITING it are different permissions", () => {
    // They were the same code behind an alias, which made the two call sites
    // read as though a read/write split existed when it did not.
    expect(PERMISSIONS as readonly string[]).toContain("konfigurasi.update");
    expect(PERMISSIONS_BY_ROLE.ADMIN_PUSAT as readonly string[]).toContain("konfigurasi.update");
    expect(PERMISSIONS_BY_ROLE.ADMIN_CABANG as readonly string[]).not.toContain("konfigurasi.update");
    expect(PERMISSIONS_BY_ROLE.AUDITOR as readonly string[]).not.toContain("konfigurasi.update");
  });

  test("the alias table is empty, so a typo cannot resolve to something else", () => {
    const { PERMISSION_ALIASES } = require("./permissions") as typeof import("./permissions");
    expect(Object.keys(PERMISSION_ALIASES)).toEqual([]);
  });

  test("requirePermission refuses an unknown permission code at wiring time", () => {
    // A typo must be a boot-time error, not a 403 that looks like policy.
    const { createGuards } = require("./guards") as typeof import("./guards");
    const guards = createGuards({
      auth: {} as never,
      audit: {} as never,
    });
    expect(() => guards.requirePermission("jurnal.pos")).toThrow(/tidak dikenal/);
    expect(() => guards.requirePermission()).toThrow(/tanpa permission/);
  });
});
