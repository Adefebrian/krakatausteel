import { describe, expect, test } from "bun:test";
import { tanggalLokal, ZONA_WAKTU_ENTITAS } from "./waktu";

/**
 * THE DEFECT THIS PINS was found by deploying the app locally at 00:38 WIB and
 * reading a statement whose "Tanggal cetak" said the fifth on the sixth. Not
 * one of the three thousand tests saw it, because every one of them compares
 * the application's own UTC arithmetic against itself, and UTC is
 * self-consistent. Only a clock in a real timezone disagrees.
 */
describe("tanggalLokal: hari kalender pembaca, bukan hari UTC", () => {
  test("tujuh jam pertama tiap hari: UTC masih kemarin, pembaca sudah hari ini", () => {
    // 2026-09-05 17:38 UTC is 2026-09-06 00:38 in Jakarta. This is the exact
    // instant the defect was observed at.
    const saat = new Date("2026-09-05T17:38:00Z");
    expect(saat.toISOString().slice(0, 10)).toBe("2026-09-05");
    expect(tanggalLokal(saat)).toBe("2026-09-06");
  });

  test("satu menit sebelum tengah malam lokal masih hari sebelumnya", () => {
    // 16:59 UTC = 23:59 WIB on the 5th.
    expect(tanggalLokal(new Date("2026-09-05T16:59:00Z"))).toBe("2026-09-05");
    // 17:00 UTC = 00:00 WIB on the 6th.
    expect(tanggalLokal(new Date("2026-09-05T17:00:00Z"))).toBe("2026-09-06");
  });

  test("siang hari, saat UTC dan lokal sepakat, jawabannya tidak berubah", () => {
    const siang = new Date("2026-09-05T05:00:00Z");
    expect(tanggalLokal(siang)).toBe(siang.toISOString().slice(0, 10));
  });

  test("selalu YYYY-MM-DD, dengan nol di depan", () => {
    expect(tanggalLokal(new Date("2026-01-02T03:00:00Z"))).toBe("2026-01-02");
    expect(tanggalLokal(new Date("2026-12-31T20:00:00Z"))).toBe("2027-01-01");
  });

  test("zonanya dinyatakan, bukan diwarisi dari jam server", () => {
    // A server whose own TZ is UTC must still stamp Jakarta dates, which is
    // exactly the production case: the container has no timezone set.
    expect(ZONA_WAKTU_ENTITAS).toBe("Asia/Jakarta");
  });
});
