// The portal anti-spam ceilings, proved against a fixture that does NOT raise
// them (spec 9.5: "Rate limiting dan proteksi anti spam wajib ada").
//
// ./portal-publik.test.ts raises them as a cost knob so its assertions are not
// fighting the limiter. That leaves the ceilings themselves unproved, which is
// exactly the kind of gap a cost knob opens quietly, so they get their own
// file with the shipped numbers.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createFixture, type Fixture } from "../../testing/harness";
import { nativeFetchApi } from "../../testing/native-fetch";
import {
  BATAS_CEK_PER_IP,
  BATAS_CEK_PER_TIKET,
  BATAS_PENGAJUAN_PER_IP,
  BATAS_PENGAJUAN_PER_IP_HARIAN,
} from "./contract";

describe("portal: batas anti spam yang benar-benar dikirim", () => {
  let f: Fixture;
  let kodeEntitas = "";

  async function publik(path: string, body: unknown): Promise<Response> {
    const { Request: NativeRequest } = nativeFetchApi();
    return f.ctx.app.fetch(
      new NativeRequest(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  function pengajuan(nik: string): Record<string, unknown> {
    return {
      kodeEntitas,
      jenis: "PUMK",
      emailKontak: "spam@contoh.local",
      nik,
      formulir: {
        nama_lengkap: "Pemohon Uji",
        nama_usaha: "Usaha Uji",
        alamat: "Jl. Uji 1",
        jumlah_diajukan: "10000000.00",
        tenor_diajukan: 12,
        tujuan_penggunaan: "Modal kerja",
      },
    };
  }

  beforeAll(async () => {
    // NO `portalLimits` override: the shipped ceilings apply.
    f = await createFixture();
    const rows = await f.db.query<{ kode: string }>("select kode from bumn where id = $1::uuid", [
      f.bumnId,
    ]);
    kodeEntitas = rows[0]!.kode;
  });

  afterAll(async () => {
    await f.tutup();
  });

  test("ceilings shipped: 5 pengajuan/jam per IP, 20/hari, 10 cek/5 menit, 5 salah per tiket", () => {
    // Pinned so a change to any of them is a decision somebody makes on
    // purpose rather than a diff nobody reads.
    expect(BATAS_PENGAJUAN_PER_IP).toBe(5);
    expect(BATAS_PENGAJUAN_PER_IP_HARIAN).toBe(20);
    expect(BATAS_CEK_PER_IP).toBe(10);
    expect(BATAS_CEK_PER_TIKET).toBe(5);
  });

  test("pengajuan ke-6 dari satu sumber dijawab 429 dengan kode domainnya", async () => {
    const status: number[] = [];
    for (let i = 0; i < BATAS_PENGAJUAN_PER_IP + 2; i += 1) {
      const res = await publik("/portal/pengajuan", pengajuan(`320401010190${1000 + i}`));
      status.push(res.status);
      if (res.status === 429) {
        const body = (await res.json()) as { code: string; kodeDomain?: string };
        expect(body.code).toBe("TERLALU_BANYAK_PERMINTAAN");
        expect(body.kodeDomain).toBe("TERLALU_BANYAK_PENGAJUAN");
      }
    }
    expect(status.slice(0, BATAS_PENGAJUAN_PER_IP).every((s) => s === 201)).toBe(true);
    expect(status.slice(BATAS_PENGAJUAN_PER_IP).every((s) => s === 429)).toBe(true);
  });

  test("penolakan rate limit pengajuan meninggalkan jejak di audit_log", async () => {
    const rows = await f.db.query<{ n: string }>(
      `select count(*)::text as n from audit_log
        where aksi = 'portal.ajukan' and hasil = 'DITOLAK'
          and keterangan like 'rate limit pengajuan portal%'`,
    );
    expect(Number(rows[0]?.n ?? "0")).toBeGreaterThan(0);
  });

  test("cek status berlebih dari satu sumber dijawab 429", async () => {
    const status: number[] = [];
    for (let i = 0; i < BATAS_CEK_PER_IP + 2; i += 1) {
      status.push(
        (await publik("/portal/status", { noTiket: "TKT-202601-ZZZZZZZZZZ", nik: "3204010101900001" }))
          .status,
      );
    }
    expect(status).toContain(429);
    // Never a 200 and never a 500: the only two answers are the single refusal
    // and the rate-limit refusal.
    expect(status.every((s) => s === 404 || s === 429)).toBe(true);
  });
});
