// The mitra login ceilings, proved against a fixture that does NOT raise them.
//
// ./mitra-isolasi.test.ts raises the ceilings as a cost knob so that the
// isolation assertions are not fighting the rate limiter. That leaves the
// ceilings themselves unproved, which is exactly the kind of gap a cost knob
// creates quietly, so they are proved here instead: one small file, real
// ceilings, and the two properties that matter.
//
// THE SECOND TEST IS THE IMPORTANT ONE. core/hardening.ts records that the
// staff login limiter was once a remote account-lockout weapon because it
// consumed the per-username counter BEFORE verifying the password, and it
// fails closed. The mitra login must not have that shape: a correct password
// has to win however many wrong guesses somebody else has made at that email.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createFixture, type Fixture } from "../../testing/harness";
import { nativeFetchApi } from "../../testing/native-fetch";
import { BATAS_MASUK_PER_EMAIL, BATAS_MASUK_PER_IP } from "./contract";
import { MITRA_COOKIE } from "./guards";
import { buatMitraUji } from "./test-support";

describe("mitra: batas percobaan masuk", () => {
  let f: Fixture;
  let cookieAdmin = "";

  const SANDI_BARU = "SandiMitraBaru#2026";

  async function masuk(email: string, sandi: string): Promise<Response> {
    const { Request: NativeRequest } = nativeFetchApi();
    return f.ctx.app.fetch(
      new NativeRequest("http://localhost/mitra/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, sandi }),
      }),
    );
  }

  function cookieDari(res: Response): string | null {
    const raw = res.headers.get("set-cookie");
    const m = raw ? new RegExp(`${MITRA_COOKIE}=([^;]*)`).exec(raw) : null;
    return m?.[1] && m[1].length > 0 ? m[1] : null;
  }

  async function akunSiap(nama: string, email: string): Promise<void> {
    const m = await buatMitraUji(f.db, { cabangId: f.cabangA.id, nama, suffix: f.suffix });
    const buat = await f.request("/mitra/akun", {
      cookie: cookieAdmin,
      method: "POST",
      body: { mitraId: m.mitraId, email },
    });
    expect(buat.status).toBe(201);
    const { sandiSementara } = (await buat.json()) as { sandiSementara: string };
    const pertama = await masuk(email, sandiSementara);
    const cookie = cookieDari(pertama)!;
    const { Request: NativeRequest } = nativeFetchApi();
    const ganti = await f.ctx.app.fetch(
      new NativeRequest("http://localhost/mitra/ganti-sandi", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${MITRA_COOKIE}=${cookie}` },
        body: JSON.stringify({ sandiLama: sandiSementara, sandiBaru: SANDI_BARU }),
      }),
    );
    expect(ganti.status).toBe(204);
  }

  beforeAll(async () => {
    // NO `loginLimits` override: the shipped ceilings apply.
    f = await createFixture();
    cookieAdmin = await f.login(f.users.ADMIN_PUSAT.username);
  });

  afterAll(async () => {
    await f.tutup();
  });

  test("ceilings shipped: 10 per IP, 5 kegagalan per email", () => {
    // Pinned so a change to either constant is a decision somebody makes on
    // purpose rather than a diff nobody reads.
    expect(BATAS_MASUK_PER_IP).toBe(10);
    expect(BATAS_MASUK_PER_EMAIL).toBe(5);
  });

  test("percobaan berlebih dari satu sumber dijawab 429, bukan 401", async () => {
    const email = `banjir.${f.suffix}@contoh.local`;
    await akunSiap("Mitra Banjir", email);

    const status: number[] = [];
    for (let i = 0; i < BATAS_MASUK_PER_IP + 4; i += 1) {
      status.push((await masuk(email, `Salah#${i}`)).status);
    }
    // The per-IP budget was already partly spent by `akunSiap`, so the exact
    // index of the first 429 is not the assertion; that one arrives at all is.
    expect(status).toContain(429);
    expect(status.every((s) => s === 401 || s === 429)).toBe(true);
  });

  test("sandi BENAR tetap menang setelah tebakan orang lain menghabiskan jatah email", async () => {
    // The lockout-weapon shape, tested directly. A different fixture, so this
    // email's per-IP budget is its own.
    const g = await createFixture();
    const cookie = await g.login(g.users.ADMIN_PUSAT.username);
    const email = `gembok.${g.suffix}@contoh.local`;
    const m = await buatMitraUji(g.db, {
      cabangId: g.cabangA.id,
      nama: "Mitra Gembok",
      suffix: g.suffix,
    });
    const buat = await g.request("/mitra/akun", {
      cookie,
      method: "POST",
      body: { mitraId: m.mitraId, email },
    });
    const { sandiSementara } = (await buat.json()) as { sandiSementara: string };

    const { Request: NativeRequest } = nativeFetchApi();
    const masukG = async (sandi: string): Promise<Response> =>
      g.ctx.app.fetch(
        new NativeRequest("http://localhost/mitra/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, sandi }),
        }),
      );

    // Exactly the per-email failure budget, spent by "somebody else".
    for (let i = 0; i < BATAS_MASUK_PER_EMAIL; i += 1) {
      expect((await masukG(`Tebakan#${i}`)).status).toBe(401);
    }
    // The owner then arrives with the correct password. If the counter were
    // consumed before verification, this would be a 429 and the account would
    // be locked by an attacker who never knew the password.
    const benar = await masukG(sandiSementara);
    expect(benar.status).toBe(200);
    await g.tutup();
  });
});
