import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { App } from "./App";
import { mount, submitForm, textOf, typeInto } from "./testing";

// The banned long dash, written as an escape so this file stays clean itself.
const LONG_DASH = "\u2014";

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

const SESSION = {
  user: { id: "u1", username: "adminpusat", nama: "Sri Handayani", role: "ADMIN_PUSAT" },
  cabang: { id: "c0", kode: "00", nama: "Kantor Pusat" },
  cabangTersedia: [{ id: "c0", kode: "00", nama: "Kantor Pusat" }],
  periode: { tahun: 2026, bulan: 8, status: "OPEN" },
  permissions: ["dashboard.view", "laporan.view", "jurnal.view"],
};

beforeEach(() => {
  globalThis.history.replaceState(null, "", "/");
  globalThis.sessionStorage?.clear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("session bootstrap", () => {
  test("a 401 from GET /auth/session shows the login screen, not a fake session", async () => {
    stubFetch(() => new Response(null, { status: 401 }));
    const view = await mount(<App />);

    expect(calls[0]?.url).toContain("/auth/session");
    expect(textOf(view.container.querySelector("h1"))).toBe("TJSL Online");
    expect(view.container.querySelector("#login-username")).toBeTruthy();
    // The shell must not exist while unauthenticated.
    expect(view.container.querySelector(".shell")).toBeNull();

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

    view.unmount();
  });

  test("an unreachable API shows a retry screen, never the login screen", async () => {
    // A network failure is not a rejected credential: telling the user their
    // password is wrong here would send them chasing the wrong problem.
    stubFetch(() => {
      throw new Error("network down");
    });
    const view = await mount(<App />);
    expect(textOf(view.container.querySelector("h1"))).toBe("Tidak dapat memuat sesi");
    expect(view.container.querySelector("#login-username")).toBeNull();
    view.unmount();
  });
});

describe("login screen", () => {
  test("shows an error message when POST /auth/login answers 401", async () => {
    stubFetch(() => new Response(null, { status: 401 }));

    const view = await mount(<App />);
    const username = view.container.querySelector("#login-username") as HTMLInputElement;
    const password = view.container.querySelector("#login-password") as HTMLInputElement;
    const form = view.container.querySelector("form") as HTMLFormElement;

    await typeInto(username, "maker");
    await typeInto(password, "salah");
    await submitForm(form);

    const alert = view.container.querySelector('[role="alert"]');
    expect(textOf(alert)).toContain("Nama pengguna atau kata sandi salah");
    // A rejected login must not slip into the shell through the demo stub.
    expect(view.container.querySelector(".shell")).toBeNull();
    expect(calls.some((call) => call.url.includes("/auth/login") && call.method === "POST")).toBe(
      true,
    );

    view.unmount();
  });

  test("validates empty fields before touching the network", async () => {
    stubFetch(() => new Response(null, { status: 401 }));
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

  test("a successful login swaps the login screen for the shell", async () => {
    stubFetch((call) => {
      if (call.url.includes("/auth/session")) return new Response(null, { status: 401 });
      return json(200, SESSION);
    });

    const view = await mount(<App />);
    await typeInto(
      view.container.querySelector("#login-username") as HTMLInputElement,
      "adminpusat",
    );
    await typeInto(
      view.container.querySelector("#login-password") as HTMLInputElement,
      "rahasia",
    );
    await submitForm(view.container.querySelector("form") as HTMLFormElement);

    expect(view.container.querySelector(".shell")).toBeTruthy();
    expect(view.container.querySelector("#login-username")).toBeNull();

    view.unmount();
  });
});

describe("shell navigation", () => {
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
