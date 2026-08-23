// Authentication tests: login, logout, session lifetime, rate limiting, and
// the two properties that are easy to lose by accident (no username
// enumeration, and a cookie a script cannot read).
//
// Every test drives the REAL app through HTTP, via the harness in
// src/testing/harness.ts, so the guard chain, the cookie policy and the error
// handler are all in the path.
import { describe, expect, test } from "bun:test";
import { createFixture, sessionCookieAttributes, TEST_PASSWORD } from "../../testing/harness";
import { createMemoryRateLimiter } from "../../core/adapters/ratelimit";
import { SESSION_COOKIE } from "./guards";

describe("POST /auth/login", () => {
  test("returns the session payload the SPA expects and sets a cookie", async () => {
    const f = await createFixture();
    const res = await f.tryLogin(f.users.MAKER.username, TEST_PASSWORD);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    // The contract apps/web/src/api/auth.ts declares.
    expect(body).toHaveProperty("user");
    expect(body).toHaveProperty("cabang");
    expect(body).toHaveProperty("cabangTersedia");
    expect(body).toHaveProperty("periode");
    expect(body).toHaveProperty("permissions");
    expect((body.user as { username: string }).username).toBe(f.users.MAKER.username);
    expect((body.user as { role: string }).role).toBe("MAKER");
    expect(body.roles).toEqual(["MAKER"]);
    expect((body.cabang as { id: string }).id).toBe(f.cabangA.id);
    expect(Array.isArray(body.permissions)).toBe(true);
    // The password hash must never appear anywhere in a response.
    expect(JSON.stringify(body)).not.toContain("argon2");
  });

  test("the cookie is HttpOnly, SameSite=Lax, Path=/ and not Secure in test/dev", async () => {
    const f = await createFixture();
    const res = await f.tryLogin(f.users.MAKER.username, TEST_PASSWORD);
    const attrs = sessionCookieAttributes(res);
    expect(attrs[SESSION_COOKIE]).toBeTruthy();
    expect(attrs.httponly).toBe(true);
    expect(attrs.samesite).toBe("Lax");
    expect(attrs.path).toBe("/");
    expect(Number(attrs["max-age"])).toBeGreaterThan(0);
    // Secure would mean the cookie is never stored over plain http, so local
    // development could not log in at all. It is added when NODE_ENV=production.
    expect(attrs.secure).toBeUndefined();
  });

  test("the session id is opaque: it leaks no user id and is high entropy", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.MAKER.username);
    expect(cookie).not.toContain(f.users.MAKER.id);
    expect(cookie).not.toContain(f.users.MAKER.username);
    expect(cookie.length).toBeGreaterThanOrEqual(40); // 32 bytes base64url
    const second = await f.login(f.users.MAKER.username);
    expect(second).not.toBe(cookie);
  });

  test("records last_login_at", async () => {
    const f = await createFixture();
    const before = await f.db.query<{ last_login_at: string | null }>(
      "SELECT last_login_at FROM app_user WHERE id = $1",
      [f.users.MAKER.id],
    );
    expect(before[0]!.last_login_at).toBeNull();
    await f.login(f.users.MAKER.username);
    const after = await f.db.query<{ last_login_at: string | null }>(
      "SELECT last_login_at FROM app_user WHERE id = $1",
      [f.users.MAKER.id],
    );
    expect(after[0]!.last_login_at).not.toBeNull();
  });

  test("username is case-insensitive, matching the app_user_username_uq index", async () => {
    const f = await createFixture();
    const res = await f.tryLogin(f.users.MAKER.username.toUpperCase(), TEST_PASSWORD);
    expect(res.status).toBe(200);
  });

  test("writes a SUKSES row to audit_log", async () => {
    const f = await createFixture();
    await f.login(f.users.MAKER.username);
    const rows = await f.auditRows({ aksi: "auth.login", hasil: "SUKSES" });
    const mine = rows.filter((r) => r.user_id === f.users.MAKER.id);
    expect(mine.length).toBe(1);
    expect(mine[0]!.entitas).toBe("app_user");
    expect(JSON.stringify(mine[0]!.nilai_baru_json)).toContain(f.users.MAKER.username);
  });
});

describe("POST /auth/login failure", () => {
  test("a wrong password is 401 with a generic message", async () => {
    const f = await createFixture();
    const res = await f.tryLogin(f.users.MAKER.username, "salah-sekali");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "Nama pengguna atau kata sandi salah",
      code: "TIDAK_TERAUTENTIKASI",
    });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("an unknown username is INDISTINGUISHABLE from a wrong password", async () => {
    // No username enumeration: same status, same body, no hint anywhere in the
    // response. Which of the two it was is recorded in audit_log instead.
    const f = await createFixture();
    const wrongPassword = await f.tryLogin(f.users.MAKER.username, "salah-sekali");
    const unknownUser = await f.tryLogin(`tidak-ada-${f.suffix}`, "salah-sekali");
    expect(unknownUser.status).toBe(wrongPassword.status);
    expect(await unknownUser.text()).toBe(await wrongPassword.text());
  });

  test("a deactivated account is also indistinguishable, and cannot log in", async () => {
    const f = await createFixture();
    await f.db.query("UPDATE app_user SET aktif = false WHERE id = $1", [f.users.CHECKER.id]);
    const res = await f.tryLogin(f.users.CHECKER.username, TEST_PASSWORD);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "Nama pengguna atau kata sandi salah",
      code: "TIDAK_TERAUTENTIKASI",
    });
  });

  test("every failed attempt writes a DITOLAK row naming the real reason", async () => {
    const f = await createFixture();
    await f.tryLogin(f.users.MAKER.username, "salah-sekali");
    await f.tryLogin(`tidak-ada-${f.suffix}`, "salah-sekali");

    const denied = await f.auditRows({ aksi: "auth.login", hasil: "DITOLAK" });
    const reasons = denied.map((r) => r.keterangan);
    // The distinction the HTTP response refuses to make lives here, where an
    // auditor can see it and an attacker cannot.
    expect(reasons).toContain("kata sandi salah");
    expect(reasons).toContain("username tidak ditemukan");
  });

  test("a malformed body is 400 with field detail, not 401", async () => {
    const f = await createFixture();
    const res = await f.request("/auth/login", { method: "POST", body: { username: "" } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; detail: Record<string, string[]> };
    expect(body.code).toBe("VALIDASI");
    expect(body.detail.username).toBeDefined();
    expect(body.detail.password).toBeDefined();
  });

  test("an absurdly long username or password is rejected before hashing", async () => {
    const f = await createFixture();
    const res = await f.request("/auth/login", {
      method: "POST",
      body: { username: "a".repeat(500), password: "b".repeat(5000) },
    });
    expect(res.status).toBe(400);
  });
});

describe("login rate limiting", () => {
  test("trips well before the global limiter and answers 429 with Retry-After", async () => {
    // The global limiter is 120 per minute; login is 4 per username here (5 in
    // production), which is the "stricter on auth endpoints" rule.
    const f = await createFixture({
      loginLimiter: createMemoryRateLimiter(),
      loginLimits: { perIp: 50, perUsername: 4, windowSeconds: 300 },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await f.tryLogin(f.users.MAKER.username, "salah");
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(statuses.slice(4)).toEqual([429, 429]);
  });

  test("the 429 body says how long to wait and audit_log records the refusal", async () => {
    const f = await createFixture({
      loginLimiter: createMemoryRateLimiter(),
      loginLimits: { perIp: 50, perUsername: 1, windowSeconds: 120 },
    });
    await f.tryLogin(f.users.MAKER.username, "salah");
    const res = await f.tryLogin(f.users.MAKER.username, "salah");
    expect(res.status).toBe(429);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("TERLALU_BANYAK_PERMINTAAN");
    expect(body.error).toMatch(/Coba lagi dalam \d+ detik/);

    const denied = await f.auditRows({ aksi: "auth.login", hasil: "DITOLAK" });
    expect(denied.some((r) => (r.keterangan ?? "").includes("rate limit"))).toBe(true);
  });

  test("the per-IP limit stops one host spraying many different accounts", async () => {
    const f = await createFixture({
      loginLimiter: createMemoryRateLimiter(),
      loginLimits: { perIp: 3, perUsername: 100, windowSeconds: 300 },
    });
    const targets = [f.users.MAKER, f.users.CHECKER, f.users.APPROVER, f.users.AUDITOR];
    const statuses: number[] = [];
    for (const target of targets) {
      statuses.push((await f.tryLogin(target.username, "salah")).status);
    }
    expect(statuses).toEqual([401, 401, 401, 429]);
  });

  test("a successful login clears the per-username counter", async () => {
    const f = await createFixture({
      loginLimiter: createMemoryRateLimiter(),
      loginLimits: { perIp: 50, perUsername: 3, windowSeconds: 300 },
    });
    await f.tryLogin(f.users.MAKER.username, "salah");
    await f.tryLogin(f.users.MAKER.username, "salah");
    expect((await f.tryLogin(f.users.MAKER.username, TEST_PASSWORD)).status).toBe(200);
    // Two fumbles then a success must not leave the user one attempt from a
    // lockout.
    expect((await f.tryLogin(f.users.MAKER.username, "salah")).status).toBe(401);
    expect((await f.tryLogin(f.users.MAKER.username, "salah")).status).toBe(401);
  });
});

describe("GET /auth/session", () => {
  test("401 without a cookie, and the denial is logged", async () => {
    const f = await createFixture();
    const res = await f.request("/auth/session");
    expect(res.status).toBe(401);
    const denied = await f.auditRows({ hasil: "DITOLAK", aksi: "auth.akses" });
    expect(denied.some((r) => r.keterangan === "tidak ada cookie sesi")).toBe(true);
  });

  test("401 for a fabricated session id", async () => {
    const f = await createFixture();
    const res = await f.request("/auth/session", { cookie: "a".repeat(43) });
    expect(res.status).toBe(401);
  });

  test("200 with the same payload as login for a valid session", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.APPROVER.username);
    const res = await f.request("/auth/session", { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { role: string }; permissions: string[] };
    expect(body.user.role).toBe("APPROVER");
    expect(body.permissions).toContain("jurnal.post");
    expect(body.permissions).not.toContain("pumk.create");
  });

  test("permissions come from the database, not from the role name", async () => {
    // Revoking a grant takes effect on the next request: nothing about the
    // role is cached in the session.
    const f = await createFixture();
    const cookie = await f.login(f.users.APPROVER.username);
    const before = (await (await f.request("/auth/session", { cookie })).json()) as { permissions: string[] };
    expect(before.permissions).toContain("jurnal.post");

    await f.db.query(
      `DELETE FROM role_permission
        WHERE role_id = (SELECT id FROM app_role WHERE kode = 'APPROVER' AND deleted_at IS NULL)
          AND permission_id = (SELECT id FROM permission WHERE kode = 'jurnal.post')`,
    );
    try {
      const after = (await (await f.request("/auth/session", { cookie })).json()) as { permissions: string[] };
      expect(after.permissions).not.toContain("jurnal.post");
    } finally {
      // app_role and role_permission are GLOBAL tables shared with every other
      // test file in this database. Put the grant back, or a later file that
      // legitimately expects an Approver to hold jurnal.post fails for a
      // reason that has nothing to do with its own code.
      await f.db.query(
        `INSERT INTO role_permission (role_id, permission_id)
         SELECT r.id, p.id FROM app_role r, permission p
          WHERE r.kode = 'APPROVER' AND r.deleted_at IS NULL AND p.kode = 'jurnal.post'
         ON CONFLICT DO NOTHING`,
      );
    }
  });

  test("deactivating a user kills their live session immediately", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.MAKER.username);
    expect((await f.request("/auth/session", { cookie })).status).toBe(200);
    await f.db.query("UPDATE app_user SET aktif = false WHERE id = $1", [f.users.MAKER.id]);
    expect((await f.request("/auth/session", { cookie })).status).toBe(401);
  });
});

describe("session lifetime", () => {
  test("expires after the idle timeout", async () => {
    // Deterministic: the clock is injected and moved, nothing sleeps.
    const f = await createFixture({ sessionOptions: { idleTtlSeconds: 60, absoluteTtlSeconds: 3600 } });
    const cookie = await f.login(f.users.MAKER.username);
    expect((await f.request("/auth/session", { cookie })).status).toBe(200);
    f.clock.advance(61_000);
    expect((await f.request("/auth/session", { cookie })).status).toBe(401);
  });

  test("the idle timeout slides while the session is in use", async () => {
    const f = await createFixture({ sessionOptions: { idleTtlSeconds: 60, absoluteTtlSeconds: 3600 } });
    const cookie = await f.login(f.users.MAKER.username);
    for (let i = 0; i < 5; i += 1) {
      f.clock.advance(45_000); // less than the idle timeout each time
      expect((await f.request("/auth/session", { cookie })).status).toBe(200);
    }
  });

  test("the absolute timeout ends the session even if it is in constant use", async () => {
    // Otherwise a script polling /auth/session keeps a session alive forever.
    const f = await createFixture({ sessionOptions: { idleTtlSeconds: 60, absoluteTtlSeconds: 120 } });
    const cookie = await f.login(f.users.MAKER.username);
    f.clock.advance(50_000);
    expect((await f.request("/auth/session", { cookie })).status).toBe(200);
    f.clock.advance(50_000);
    expect((await f.request("/auth/session", { cookie })).status).toBe(200);
    f.clock.advance(50_000); // now past 120s total
    expect((await f.request("/auth/session", { cookie })).status).toBe(401);
  });

  test("an expired session id is removed from the store, not left to rot", async () => {
    const f = await createFixture({ sessionOptions: { idleTtlSeconds: 30, absoluteTtlSeconds: 3600 } });
    const cookie = await f.login(f.users.MAKER.username);
    f.clock.advance(31_000);
    await f.request("/auth/session", { cookie });
    expect(await f.ctx.kv.get(`tjsl:sess:${cookie}`)).toBeNull();
  });
});

describe("POST /auth/logout", () => {
  test("204, clears the cookie, and the session no longer resolves", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.MAKER.username);
    const res = await f.request("/auth/logout", { method: "POST", cookie });
    expect(res.status).toBe(204);
    expect(sessionCookieAttributes(res)["max-age"]).toBe("0");
    expect((await f.request("/auth/session", { cookie })).status).toBe(401);
  });

  test("logging out one session leaves another session of the same user alone", async () => {
    const f = await createFixture();
    const laptop = await f.login(f.users.MAKER.username);
    const phone = await f.login(f.users.MAKER.username);
    await f.request("/auth/logout", { method: "POST", cookie: laptop });
    expect((await f.request("/auth/session", { cookie: laptop })).status).toBe(401);
    expect((await f.request("/auth/session", { cookie: phone })).status).toBe(200);
  });

  test("is 204 even with no cookie or an invalid one, so the SPA can always recover", async () => {
    const f = await createFixture();
    expect((await f.request("/auth/logout", { method: "POST" })).status).toBe(204);
    expect((await f.request("/auth/logout", { method: "POST", cookie: "b".repeat(43) })).status).toBe(204);
  });

  test("a read-only role can still log out (it is not a data change)", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.AUDITOR.username);
    expect((await f.request("/auth/logout", { method: "POST", cookie })).status).toBe(204);
  });

  test("writes a SUKSES row to audit_log", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.MAKER.username);
    await f.request("/auth/logout", { method: "POST", cookie });
    const rows = await f.auditRows({ aksi: "auth.logout" });
    expect(rows.some((r) => r.user_id === f.users.MAKER.id && r.hasil === "SUKSES")).toBe(true);
  });
});

describe("audit_log IP recording", () => {
  test("with one trusted proxy configured, records the real client, not the forged hop", async () => {
    const saved = process.env.TRUSTED_PROXY_COUNT;
    process.env.TRUSTED_PROXY_COUNT = "1";
    const { resetTrustedProxyConfig } = await import("../../core/hardening");
    resetTrustedProxyConfig();
    try {
      const f = await createFixture();
      await f.request("/auth/login", {
        method: "POST",
        body: { username: f.users.MAKER.username, password: TEST_PASSWORD },
        forwardedFor: "1.2.3.4, 203.0.113.77",
      });
      const rows = await f.auditRows({ aksi: "auth.login", hasil: "SUKSES" });
      const mine = rows.find((r) => r.user_id === f.users.MAKER.id);
      expect(mine?.ip).toBe("203.0.113.77");
    } finally {
      if (saved === undefined) delete process.env.TRUSTED_PROXY_COUNT;
      else process.env.TRUSTED_PROXY_COUNT = saved;
      resetTrustedProxyConfig();
    }
  });

  test("with no proxy configured, a forged XFF is ignored and the IP is NULL", async () => {
    // NULL is the honest answer for a synthetic request with no socket peer.
    // The important half is that "1.2.3.4" never lands in the audit trail.
    const f = await createFixture();
    await f.request("/auth/login", {
      method: "POST",
      body: { username: f.users.CHECKER.username, password: TEST_PASSWORD },
      forwardedFor: "1.2.3.4",
    });
    const rows = await f.auditRows({ aksi: "auth.login", hasil: "SUKSES" });
    const mine = rows.find((r) => r.user_id === f.users.CHECKER.id);
    expect(mine?.ip).toBeNull();
  });
});
