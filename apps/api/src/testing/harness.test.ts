// Self-test for the authorisation harness. If this file fails, every other
// authorisation test in the repo is suspect, so it asserts the properties the
// harness claims rather than any application behaviour.
import { describe, expect, test } from "bun:test";
import { createFixture, createTestClock, TEST_PASSWORD } from "./harness";
import { globalRequestDropsCookies, nativeFetchApi } from "./native-fetch";

describe("harness", () => {
  test("the app under test is built by the real factory and answers over HTTP", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.MAKER.username, TEST_PASSWORD);
    const res = await f.request("/auth/session", { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { username: string }; permissions: string[] };
    expect(body.user.username).toBe(f.users.MAKER.username);
    expect(body.permissions).toContain("pumk.create");
  });

  test("fixtures are isolated: two fixtures share no users, branches or entity", async () => {
    // Another agent resets this database mid-run, and test files share one
    // Postgres, so nothing may depend on another file's rows.
    const a = await createFixture();
    const b = await createFixture();
    expect(a.bumnId).not.toBe(b.bumnId);
    expect(a.cabangA.id).not.toBe(b.cabangA.id);
    expect(a.users.MAKER.username).not.toBe(b.users.MAKER.username);
  });

  test("the fixture covers every role plus a same-role user in another branch", async () => {
    const f = await createFixture();
    expect(Object.keys(f.users).sort()).toEqual(
      ["ADMIN_CABANG", "ADMIN_PUSAT", "APPROVER", "AUDITOR", "CHECKER", "MAKER", "MAKER_B"].sort(),
    );
    expect(f.users.MAKER.cabang.id).toBe(f.cabangA.id);
    expect(f.users.MAKER_B.cabang.id).toBe(f.cabangB.id);
    expect(f.users.ADMIN_PUSAT.cabang.id).toBe(f.pusat.id);
  });

  test("the injected clock is what the session store reads, so expiry needs no sleeping", async () => {
    const clock = createTestClock(new Date("2026-01-01T00:00:00.000Z"));
    const f = await createFixture({ clock, sessionOptions: { idleTtlSeconds: 10 } });
    const cookie = await f.login(f.users.MAKER.username);
    const raw = await f.ctx.kv.get(`tjsl:sess:${cookie}`);
    expect(raw).not.toBeNull();
    const record = JSON.parse(raw!) as { createdAt: string };
    expect(record.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("documents WHY it builds requests with the native fetch API", () => {
    // If this ever reports false, the happy-dom workaround in
    // tools/test-env.ts and ./native-fetch.ts can be deleted. Until then it is
    // load-bearing: happy-dom's Request drops the Cookie header, which would
    // make every authenticated test silently anonymous and passing.
    expect(globalRequestDropsCookies()).toBe(true);
    const probe = new (nativeFetchApi().Request)("http://localhost/x", { headers: { cookie: "a=1" } });
    expect(probe.headers.get("cookie")).toBe("a=1");
  });
});
