// Session and shell tests, written against the REAL /auth contract in
// apps/api/src/modules/auth/routes.ts. There is no demo stub any more: every
// answer in these tests is a response the API can actually produce, and the
// fetch double below only replaces the transport.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { App } from "./App";
import { clickOn, mount, submitForm, textOf, typeInto } from "./testing";

// The banned long dash, written as an escape so this file stays clean itself.
const LONG_DASH = "—";

type FetchFn = typeof globalThis.fetch;

const realFetch: FetchFn = globalThis.fetch;

interface Call {
  url: string;
  method: string;
  body: string | null;
}

let calls: Call[] = [];

function stubFetch(handler: (call: Call) => Response) {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    return handler(call);
  }) as FetchFn;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The API's error envelope, core/http.ts's AppErrorBody. */
function apiError(status: number, error: string, code: string): Response {
  return json(status, { error, code });
}

const NO_SESSION = () => apiError(401, "Sesi tidak valid", "TIDAK_TERAUTENTIKASI");

// Exactly the payload apps/api's payloadFor() returns, extra fields included,
// so a drift in the contract shows up here rather than in a browser.
const SESSION = {
  user: { id: "u1", username: "adminpusat", nama: "Sri Handayani", role: "ADMIN_PUSAT" },
  cabang: { id: "c0", kode: "00", nama: "Kantor Pusat" },
  cabangTersedia: [{ id: "c0", kode: "00", nama: "Kantor Pusat" }],
  periode: { tahun: 2026, bulan: 8, status: "OPEN" },
  permissions: ["dashboard.view", "laporan.view", "jurnal.view"],
  roles: ["ADMIN_PUSAT"],
  readOnly: false,
  lintasCabang: true,
};

const SESSION_MAKER = {
  ...SESSION,
  user: { id: "u2", username: "budi", nama: "Budi Santoso", role: "MAKER" },
  cabang: { id: "c1", kode: "01", nama: "Cabang Cilegon" },
  cabangTersedia: [{ id: "c1", kode: "01", nama: "Cabang Cilegon" }],
  permissions: ["dashboard.view", "pumk.view", "pumk.create", "jurnal.view", "jurnal.create"],
  roles: ["MAKER"],
  lintasCabang: false,
};

beforeEach(() => {
  globalThis.history.replaceState(null, "", "/");
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("auth client", () => {
  test("talks to the API under the /api prefix, the same one Caddy strips", async () => {
    // infra/Caddyfile routes /api/* to the Hono app with the prefix stripped,
    // and apps/web/server.ts mirrors it in development. A call to a bare
    // /auth/session would hit the SPA fallback and get index.html back.
    stubFetch(NO_SESSION);
    const view = await mount(<App />);
    expect(calls[0]?.url).toBe("/api/auth/session");
    view.unmount();
  });

  test("sends no credential of its own: the session is a cookie it cannot read", async () => {
    stubFetch(NO_SESSION);
    const view = await mount(<App />);
    // No token in a query string, no Authorization header assembled here.
    expect(calls[0]?.url).not.toContain("token");
    expect(calls[0]?.body).toBeNull();
    view.unmount();
  });
});

describe("session bootstrap", () => {
  test("an unauthenticated first load lands on the login screen with no error on it", async () => {
    // A 401 on the very first request is the ordinary case, not a fault: the
    // user simply has not signed in. Nothing red, no retry button, just the form.
    stubFetch(NO_SESSION);
    const view = await mount(<App />);

    expect(textOf(view.container.querySelector("h1"))).toBe("TJSL Online");
    expect(view.container.querySelector("#login-username")).toBeTruthy();
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    // The shell must not exist while unauthenticated.
    expect(view.container.querySelector(".shell")).toBeNull();

    view.unmount();
  });

  test("an expired session is the same 401, so it lands on login, not an empty shell", async () => {
    stubFetch(() => new Response(null, { status: 401 }));
    const view = await mount(<App />);
    expect(view.container.querySelector("#login-username")).toBeTruthy();
    expect(view.container.querySelector(".shell")).toBeNull();
    expect(view.container.querySelector(".shell-side")).toBeNull();
    view.unmount();
  });

  test("a valid session renders the shell with cabang, periode, and the user menu", async () => {
    stubFetch(() => json(200, SESSION));
    const view = await mount(<App />);

    expect(view.container.querySelector(".shell")).toBeTruthy();
    const topbar = textOf(view.container.querySelector(".shell-topbar"));
    expect(topbar).toContain("TJSL Online");
    expect(topbar).toContain("Kantor Pusat");
    expect(topbar).toContain("Agustus 2026");
    expect(topbar).toContain("Sri Handayani");
    expect(topbar).toContain("Admin Pusat");
    // The stub's marker is gone along with the stub.
    expect(topbar).not.toContain("Mode demo");

    view.unmount();
  });
});

describe("unreachable is not the same as unauthenticated", () => {
  test("a thrown fetch shows the unreachable screen, never the login screen", async () => {
    // A network failure is not a rejected credential: telling the user their
    // password is wrong here would send them chasing the wrong problem.
    stubFetch(() => {
      throw new Error("network down");
    });
    const view = await mount(<App />);
    expect(textOf(view.container.querySelector("h1"))).toBe("Server tidak dapat dihubungi");
    expect(view.container.querySelector("#login-username")).toBeNull();
    const body = textOf(view.container.querySelector(".boot-body"));
    expect(body).toContain("bukan masalah nama pengguna atau kata sandi");
    view.unmount();
  });

  test("a 502 from the proxy in front of a dead API is unreachable, not unauthenticated", async () => {
    // apps/web/server.ts answers 502 with the API's error envelope when the API
    // is not up. That must not be read as "please log in".
    stubFetch(() => apiError(502, "Server tidak dapat dihubungi", "KESALAHAN_SERVER"));
    const view = await mount(<App />);
    expect(textOf(view.container.querySelector("h1"))).toBe("Server tidak dapat dihubungi");
    expect(view.container.querySelector("#login-username")).toBeNull();
    view.unmount();
  });

  test("a 200 that is not JSON is unreachable too, that is not the API answering", async () => {
    // The SPA server answers an unmatched path with index.html and a 200. If a
    // misconfigured deploy ever routes /api there, the honest reading is "the
    // API is not on the other end", not "your session expired".
    stubFetch(
      () =>
        new Response("<!doctype html><title>TJSL Online</title>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    const view = await mount(<App />);
    expect(textOf(view.container.querySelector("h1"))).toBe("Server tidak dapat dihubungi");
    expect(view.container.querySelector("#login-username")).toBeNull();
    view.unmount();
  });

  test("the unreachable screen retries the session request, it does not ask for a password", async () => {
    let attempts = 0;
    stubFetch(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("network down");
      return json(200, SESSION);
    });
    const view = await mount(<App />);
    expect(textOf(view.container.querySelector("h1"))).toBe("Server tidak dapat dihubungi");

    const retry = view.container.querySelector(".boot-panel .btn") as HTMLElement;
    expect(textOf(retry)).toBe("Coba hubungkan ulang");
    await clickOn(retry);

    expect(view.container.querySelector(".shell")).toBeTruthy();
    view.unmount();
  });
});

describe("login screen", () => {
  test("shows an error message when POST /auth/login answers 401", async () => {
    stubFetch(() => apiError(401, "Nama pengguna atau kata sandi salah", "TIDAK_TERAUTENTIKASI"));

    const view = await mount(<App />);
    const username = view.container.querySelector("#login-username") as HTMLInputElement;
    const password = view.container.querySelector("#login-password") as HTMLInputElement;
    const form = view.container.querySelector("form") as HTMLFormElement;

    await typeInto(username, "seseorang");
    await typeInto(password, "salah");
    await submitForm(form);

    const alert = view.container.querySelector('[role="alert"]');
    expect(textOf(alert)).toContain("Nama pengguna atau kata sandi salah");
    // A rejected login must never slip into the shell: there is no fallback left.
    expect(view.container.querySelector(".shell")).toBeNull();
    expect(calls.some((call) => call.url === "/api/auth/login" && call.method === "POST")).toBe(
      true,
    );

    view.unmount();
  });

  test("a login attempt with the API down blames the server, not the password", async () => {
    let attempts = 0;
    stubFetch(() => {
      attempts += 1;
      if (attempts === 1) return apiError(401, "Sesi tidak valid", "TIDAK_TERAUTENTIKASI");
      throw new Error("network down");
    });

    const view = await mount(<App />);
    await typeInto(
      view.container.querySelector("#login-username") as HTMLInputElement,
      "seseorang",
    );
    await typeInto(view.container.querySelector("#login-password") as HTMLInputElement, "apa saja");
    await submitForm(view.container.querySelector("form") as HTMLFormElement);

    const alert = textOf(view.container.querySelector('[role="alert"]'));
    expect(alert).toContain("Server tidak dapat dihubungi");
    expect(alert).toContain("bukan masalah kata sandi");
    expect(alert).not.toContain("kata sandi salah");
    view.unmount();
  });

  test("passes the API's own wording through for a login rate limit", async () => {
    // apps/api throws TERLALU_BANYAK_PERMINTAAN with a retry delay in the
    // sentence. Flattening that into a generic message would hide the one piece
    // of information the user needs, which is how long to wait.
    let attempts = 0;
    stubFetch(() => {
      attempts += 1;
      if (attempts === 1) return apiError(401, "Sesi tidak valid", "TIDAK_TERAUTENTIKASI");
      return apiError(
        429,
        "Terlalu banyak upaya masuk. Coba lagi dalam 42 detik.",
        "TERLALU_BANYAK_PERMINTAAN",
      );
    });

    const view = await mount(<App />);
    await typeInto(
      view.container.querySelector("#login-username") as HTMLInputElement,
      "seseorang",
    );
    await typeInto(view.container.querySelector("#login-password") as HTMLInputElement, "salah");
    await submitForm(view.container.querySelector("form") as HTMLFormElement);

    expect(textOf(view.container.querySelector('[role="alert"]'))).toContain(
      "Coba lagi dalam 42 detik",
    );
    view.unmount();
  });

  test("validates empty fields before touching the network", async () => {
    stubFetch(NO_SESSION);
    const view = await mount(<App />);
    const form = view.container.querySelector("form") as HTMLFormElement;

    const before = calls.length;
    await submitForm(form);

    const errors = [...view.container.querySelectorAll(".field-error")].map(textOf);
    expect(errors).toContain("Nama pengguna wajib diisi");
    expect(errors).toContain("Kata sandi wajib diisi");
    expect(calls.length).toBe(before);

    view.unmount();
  });

  test("prints no credential on itself", async () => {
    // The demo hint used to list usernames here. A login screen that documents
    // its own accounts is a login screen that ships those accounts to production.
    stubFetch(NO_SESSION);
    const view = await mount(<App />);
    const text = (view.container.textContent ?? "").toLowerCase();
    expect(text).not.toContain("demo");
    expect(text).not.toContain("stub");
    expect(text).not.toContain("maker");
    expect(text).not.toContain("adminpusat");
    view.unmount();
  });

  test("a successful login swaps the login screen for the shell", async () => {
    stubFetch((call) => {
      if (call.url.includes("/auth/session")) {
        return apiError(401, "Sesi tidak valid", "TIDAK_TERAUTENTIKASI");
      }
      return json(200, SESSION);
    });

    const view = await mount(<App />);
    await typeInto(
      view.container.querySelector("#login-username") as HTMLInputElement,
      "adminpusat",
    );
    await typeInto(view.container.querySelector("#login-password") as HTMLInputElement, "rahasia");
    await submitForm(view.container.querySelector("form") as HTMLFormElement);

    expect(view.container.querySelector(".shell")).toBeTruthy();
    expect(view.container.querySelector("#login-username")).toBeNull();
    expect(calls.at(-1)?.body).toBe(
      JSON.stringify({ username: "adminpusat", password: "rahasia" }),
    );

    view.unmount();
  });
});

describe("logout", () => {
  test("calls POST /auth/logout and lands back on the login screen", async () => {
    stubFetch((call) => {
      if (call.url.includes("/auth/logout")) return new Response(null, { status: 204 });
      return json(200, SESSION);
    });

    const view = await mount(<App />);
    await clickOn(view.container.querySelector(".shell-user-btn") as HTMLElement);
    await clickOn(view.container.querySelector(".shell-menu-action") as HTMLElement);

    expect(calls.some((call) => call.url === "/api/auth/logout" && call.method === "POST")).toBe(
      true,
    );
    expect(view.container.querySelector(".shell")).toBeNull();
    expect(view.container.querySelector("#login-username")).toBeTruthy();

    view.unmount();
  });

  test("a logout the server never received keeps the user signed in and says so", async () => {
    // The session lives in Redis. If the request did not land, the session is
    // still live, and showing a login screen would be claiming otherwise.
    stubFetch((call) => {
      if (call.url.includes("/auth/logout")) throw new Error("network down");
      return json(200, SESSION);
    });

    const view = await mount(<App />);
    await clickOn(view.container.querySelector(".shell-user-btn") as HTMLElement);
    await clickOn(view.container.querySelector(".shell-menu-action") as HTMLElement);

    expect(view.container.querySelector(".shell")).toBeTruthy();
    expect(textOf(view.container.querySelector(".toast"))).toContain("Gagal keluar");

    view.unmount();
  });
});

describe("revalidation when the tab comes back to the front", () => {
  test("a session that expired while the tab was idle sends the user to login", async () => {
    // Redis drops the session on an idle TTL, so a tab left open overnight can
    // be holding a shell whose session no longer exists. Every button in it
    // would fail. Checking on focus turns that into one honest login prompt.
    let live = true;
    stubFetch(() => (live ? json(200, SESSION) : NO_SESSION()));

    const view = await mount(<App />);
    expect(view.container.querySelector(".shell")).toBeTruthy();

    live = false;
    await act(async () => {
      globalThis.dispatchEvent(new Event("focus"));
    });
    await view.flush();

    expect(view.container.querySelector(".shell")).toBeNull();
    expect(view.container.querySelector("#login-username")).toBeTruthy();
    view.unmount();
  });

  test("a network blip on that check does NOT sign anyone out", async () => {
    // Losing wifi for a second is not a revoked session. Throwing the user out
    // of a half filled form over it would be its own bug.
    let online = true;
    stubFetch(() => {
      if (!online) throw new Error("network down");
      return json(200, SESSION);
    });

    const view = await mount(<App />);
    online = false;
    await act(async () => {
      globalThis.dispatchEvent(new Event("focus"));
    });
    await view.flush();

    expect(view.container.querySelector(".shell")).toBeTruthy();
    expect(view.container.querySelector("#login-username")).toBeNull();
    view.unmount();
  });
});

describe("shell navigation is driven by the session permission list", () => {
  test("renders only the groups the session permissions allow", async () => {
    stubFetch(() => json(200, SESSION));
    const view = await mount(<App />);
    const nav = textOf(view.container.querySelector(".shell-side"));

    expect(nav).toContain("Dashboard");
    expect(nav).toContain("Jurnal");
    expect(nav).toContain("Laporan");
    // Not in the permission list above, so these groups must not render.
    expect(nav).not.toContain("Konfigurasi");
    expect(nav).not.toContain("Pendanaan UMK");
    expect(nav).not.toContain("Tools");

    view.unmount();
  });

  test("a different permission list changes the nav, so the list is what drives it", async () => {
    // Proof the nav reads `permissions` rather than the role name: this payload
    // carries pumk.* where the previous one did not, and Pendanaan UMK appears.
    stubFetch(() => json(200, SESSION_MAKER));
    const view = await mount(<App />);
    const nav = textOf(view.container.querySelector(".shell-side"));

    expect(nav).toContain("Pendanaan UMK");
    expect(nav).toContain("Jurnal");
    expect(nav).not.toContain("Laporan");
    expect(nav).not.toContain("Konfigurasi");
    expect(textOf(view.container.querySelector(".shell-topbar"))).toContain("Cabang Cilegon");

    view.unmount();
  });

  test("an empty permission list renders no nav item, not the whole menu", async () => {
    stubFetch(() => json(200, { ...SESSION, permissions: [], roles: [], readOnly: true }));
    const view = await mount(<App />);
    expect(view.container.querySelectorAll(".shell-side a")).toHaveLength(0);
    // Only the Menu tab, which is not permission gated.
    expect(view.container.querySelectorAll(".shell-tabbar .tab")).toHaveLength(1);
    view.unmount();
  });

  test("an unknown path renders the not found page instead of a blank screen", async () => {
    globalThis.history.replaceState(null, "", "/tidak-ada-halaman-ini");
    stubFetch(() => json(200, SESSION));
    const view = await mount(<App />);
    expect(textOf(view.container.querySelector("h1"))).toBe("Halaman tidak ditemukan");
    view.unmount();
  });

  test("a path the permission set lacks renders the forbidden page", async () => {
    globalThis.history.replaceState(null, "", "/konfigurasi/coa");
    stubFetch(() => json(200, SESSION));
    const view = await mount(<App />);
    expect(textOf(view.container.querySelector("h1"))).toBe("Akses ditolak");
    view.unmount();
  });

  test("never renders a long dash anywhere on screen", async () => {
    stubFetch(() => json(200, SESSION));
    const view = await mount(<App />);
    expect(view.container.textContent ?? "").not.toContain(LONG_DASH);
    view.unmount();
  });
});
