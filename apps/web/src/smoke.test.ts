// Browser smoke test: does the built SPA actually behave in a real browser.
// Uses puppeteer-core against the OS's installed Chromium/Chrome, never the
// heavy bundled Puppeteer download. Gated: when no system Chromium and no
// CHROME_PATH are available, every test in this file is skipped so
// `bun test` still passes in an environment with no browser installed
// (e.g. this template's own CI verification, or a bare dev container).
//
// WHAT IS REAL HERE AND WHAT IS NOT
// The browser, the built bundle, apps/web/server.ts, its /api proxy, the
// HttpOnly cookie round trip, and the SPA's own state machine are all real.
// The thing on the far side of the proxy is a stand-in that speaks the same
// contract as apps/api/src/modules/auth/routes.ts, because this suite must not
// require Postgres and Redis to be up. It lives in this test file and ships
// nowhere: the SPA itself has no fallback of any kind since the demo stub was
// deleted, which is the point of the "server is down" case at the bottom.
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Browser, BrowserContext, Page } from "puppeteer-core";

function findChromePath(): string | undefined {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

const chromePath = findChromePath();

// Same name apps/api sets, apps/api/src/modules/auth/guards.ts.
const SESSION_COOKIE = "tjsl_sid";
const USERNAME = "adminpusat";
const PASSWORD = "TjslDemo#2026";

// The payload shape apps/api's payloadFor() returns. `permissions` is short on
// purpose: the nav assertions below prove the SPA renders from this list.
const PAYLOAD = {
  user: { id: "u1", username: USERNAME, nama: "Sri Handayani", role: "ADMIN_PUSAT" },
  cabang: { id: "c0", kode: "00", nama: "Kantor Pusat" },
  cabangTersedia: [{ id: "c0", kode: "00", nama: "Kantor Pusat" }],
  periode: { tahun: 2026, bulan: 8, status: "OPEN" },
  permissions: ["dashboard.view", "laporan.view", "jurnal.view"],
  roles: ["ADMIN_PUSAT"],
  readOnly: false,
  lintasCabang: true,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Stand-in for apps/api's /auth routes: server side session set, session
 * looked up by cookie, session destroyed on logout. Same status codes, same
 * error envelope, same cookie flags.
 */
function createAuthDouble() {
  const sessions = new Set<string>();

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const cookie = req.headers.get("cookie") ?? "";
      const held = /(?:^|;\s*)tjsl_sid=([^;]*)/.exec(cookie)?.[1] ?? "";

      if (url.pathname === "/auth/session") {
        if (!held || !sessions.has(held)) {
          return json({ error: "Sesi tidak valid", code: "TIDAK_TERAUTENTIKASI" }, 401);
        }
        return json(PAYLOAD);
      }

      if (url.pathname === "/auth/login" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as {
          username?: string;
          password?: string;
        };
        if (body.username !== USERNAME || body.password !== PASSWORD) {
          return json(
            { error: "Nama pengguna atau kata sandi salah", code: "TIDAK_TERAUTENTIKASI" },
            401,
          );
        }
        const id = crypto.randomUUID();
        sessions.add(id);
        return new Response(JSON.stringify(PAYLOAD), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800`,
          },
        });
      }

      if (url.pathname === "/auth/logout" && req.method === "POST") {
        if (held) sessions.delete(held);
        return new Response(null, {
          status: 204,
          headers: { "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` },
        });
      }

      return json({ error: "Tidak ditemukan", code: "TIDAK_DITEMUKAN" }, 404);
    },
  });

  return { server, sessions };
}

describe.skipIf(!chromePath)("smoke: built SPA in a real browser", () => {
  let browser: Browser;
  let web: ReturnType<typeof Bun.serve>;
  let auth: ReturnType<typeof createAuthDouble>;
  const realApiOrigin = process.env.API_ORIGIN;

  // A FRESH browser context per page, not just a fresh tab: the session is a
  // cookie, and a shared cookie jar would leave a later test already signed in
  // by an earlier one, which is exactly the kind of accidental state that makes
  // an auth test pass for the wrong reason.
  const contexts: BrowserContext[] = [];

  async function open(): Promise<Page> {
    const context = await browser.createBrowserContext();
    contexts.push(context);
    const page = await context.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`http://localhost:${web.port}`, { waitUntil: "networkidle0" });
    return page;
  }

  async function signIn(page: Page): Promise<void> {
    await page.waitForSelector("#login-username", { timeout: 5000 });
    await page.type("#login-username", USERNAME);
    await page.type("#login-password", PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector(".shell", { timeout: 5000 });
  }

  beforeAll(async () => {
    // The happy-dom preload (required for App.test.tsx) patches globals like
    // fetch/WebSocket in this same process. puppeteer-core needs the real
    // Bun implementations to talk to the browser's remote debugging
    // protocol, so undo the patch for the lifetime of this suite.
    GlobalRegistrator.unregister();

    const distIndex = new URL("../dist/index.html", import.meta.url);
    if (!existsSync(distIndex)) {
      // Build once if a previous `bun run build` has not populated dist/ yet.
      await import("../build");
    }

    const puppeteer = (await import("puppeteer-core")).default;
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ["--no-sandbox", "--disable-gpu"],
    });

    auth = createAuthDouble();
    process.env.API_ORIGIN = `http://127.0.0.1:${auth.server.port}`;

    const { app } = await import("../server");
    web = Bun.serve({ fetch: app.fetch, port: 0 });
  });

  afterAll(async () => {
    for (const context of contexts) await context.close().catch(() => {});
    await browser?.close();
    web?.stop();
    auth?.server.stop();
    if (realApiOrigin === undefined) delete process.env.API_ORIGIN;
    else process.env.API_ORIGIN = realApiOrigin;
    // Re-register with the same url src/happydom.ts uses. Registering without
    // it lands on about:blank, where history.replaceState leaves
    // location.pathname as "blank" and every routing test in a file that runs
    // after this one resolves to the same bogus path.
    GlobalRegistrator.register({ url: "http://localhost:3000/" });
  });

  test("an unauthenticated first load lands on the login screen, not an error", async () => {
    const page = await open();
    await page.waitForSelector("#login-username", { timeout: 5000 });
    const heading = await page.$eval("h1", (el) => el.textContent);
    expect(heading).toContain("TJSL Online");
    // No session, but nothing failed, so nothing complains.
    expect(await page.$('[role="alert"]')).toBeNull();
    expect(await page.$(".shell")).toBeNull();
    await page.close();
  });

  test("a wrong password shows the login error and no session is created", async () => {
    const page = await open();
    await page.waitForSelector("#login-username", { timeout: 5000 });
    await page.type("#login-username", USERNAME);
    await page.type("#login-password", "kata sandi salah");
    await page.click('button[type="submit"]');
    await page.waitForSelector(".login-error", { timeout: 5000 });

    const message = await page.$eval(".login-error", (el) => el.textContent ?? "");
    expect(message).toContain("Nama pengguna atau kata sandi salah");
    expect(await page.$(".shell")).toBeNull();
    // A rejected login mints nothing.
    expect(auth.sessions.size).toBe(0);
    await page.close();
  });

  test("a correct password lands on the dashboard, and the nav follows the permission list", async () => {
    const page = await open();
    await signIn(page);

    expect(await page.$eval("h1", (el) => el.textContent ?? "")).toContain("Dashboard");
    const nav = await page.$eval(".shell-side", (el) => el.textContent ?? "");
    // In the permission list the double sends.
    expect(nav).toContain("Dashboard");
    expect(nav).toContain("Jurnal");
    expect(nav).toContain("Laporan");
    // Not in it, so absent from the rendered nav.
    expect(nav).not.toContain("Konfigurasi");
    expect(nav).not.toContain("Pendanaan UMK");

    await page.close();
  });

  test("a reload keeps the session, because the cookie survives the page", async () => {
    const page = await open();
    await signIn(page);
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector(".shell", { timeout: 5000 });
    expect(await page.$("#login-username")).toBeNull();
    await page.close();
  });

  test("logout destroys the server side session, so a reload lands on login", async () => {
    // Counted relative to what is already there: an earlier test in this file
    // signed in too, and asserting an absolute count would be asserting the
    // order the file happens to run in.
    const before = auth.sessions.size;
    const page = await open();
    await signIn(page);
    expect(auth.sessions.size).toBe(before + 1);

    await page.click(".shell-user-btn");
    await page.waitForSelector(".shell-menu-action", { timeout: 5000 });
    await page.click(".shell-menu-action");
    await page.waitForSelector("#login-username", { timeout: 5000 });

    // The proof that this is not a client side illusion: this session is gone
    // from the server's own store, and a reload cannot resurrect it.
    expect(auth.sessions.size).toBe(before);
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector("#login-username", { timeout: 5000 });
    expect(await page.$(".shell")).toBeNull();
    await page.close();
  });

  test("a session the server no longer knows sends the user to login, not to an empty shell", async () => {
    const page = await open();
    await signIn(page);
    // Expire it out from under the browser, exactly what a Redis idle TTL does.
    auth.sessions.clear();
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector("#login-username", { timeout: 5000 });
    expect(await page.$(".shell")).toBeNull();
    expect(await page.$(".shell-side")).toBeNull();
    await page.close();
  });

  test("an API that is down reads as unreachable, NOT as a login prompt", async () => {
    // The one distinction an accounting user has to be able to make. With the
    // demo stub deleted there is nothing left to paper over this: the SPA says
    // the server is unreachable and offers to reconnect, and it never shows a
    // password field, because no password would help.
    // Runs last on purpose: it takes the double down for good.
    auth.server.stop(true);
    const page = await open();
    await page.waitForSelector(".boot-panel", { timeout: 5000 });
    const heading = await page.$eval("h1", (el) => el.textContent ?? "");
    expect(heading).toBe("Server tidak dapat dihubungi");
    expect(await page.$("#login-username")).toBeNull();
    const body = await page.$eval(".boot-body", (el) => el.textContent ?? "");
    expect(body).toContain("bukan masalah nama pengguna atau kata sandi");
    await page.close();
  });
});
