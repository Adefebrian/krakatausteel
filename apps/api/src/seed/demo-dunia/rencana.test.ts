// The demo world's SHAPE, checked without a database.
//
// The generator itself takes fourteen seconds and replays twenty four months
// through real Postgres; running it inside `bun test` would put that on every
// gate for data no unit test asks for. What IS worth pinning here is the part
// that breaks first when somebody adjusts the mix: the counts spec 13 names,
// the fact that every state of both state machines is represented, and the one
// allocation rule that is a hard database constraint rather than a preference
// (one live akad per mitra).
import { describe, expect, test } from "bun:test";
import { STATUS_TERMINAL, TRANSISI_SAH } from "../../modules/pumk";
import { STATUS_TERMINAL_NON_PUMK, TRANSISI_SAH_NON_PUMK } from "../../modules/nonpumk";
import { dadu } from "./acak";
import { JUMLAH_MITRA } from "./mitra";
import { JUMLAH_AKAD, JUMLAH_PROPOSAL, SEBARAN_STATUS, rencanakanPumk } from "./pumk";
import { JUMLAH_NON_PUMK, SEBARAN_NON_PUMK } from "./nonpumk";
import { JUMLAH_SUBMISSION, SEBARAN_SUBMISSION } from "./portal";
import type { MitraDemo } from "./mitra";

function mitraPalsu(n: number): MitraDemo[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `mitra-${i}`,
    kode: `MTR-01-${String(i).padStart(4, "0")}`,
    nama: `Mitra ${i}`,
    cabangKode: "01",
    cabangId: "cabang-01",
    sektorId: "sektor-1",
    sektorKode: "DAG",
    namaUsaha: `Usaha ${i}`,
  }));
}

/** Every status the PUMK machine can reach, derived from the machine itself. */
function statusPumk(): Set<string> {
  const s = new Set<string>(["DRAFT"]);
  for (const t of TRANSISI_SAH) {
    s.add(t.dari);
    s.add(t.ke);
  }
  for (const t of STATUS_TERMINAL) s.add(t);
  return s;
}

function statusNonPumk(): Set<string> {
  const s = new Set<string>(["DRAFT"]);
  for (const t of TRANSISI_SAH_NON_PUMK) {
    s.add(t.dari);
    s.add(t.ke);
  }
  for (const t of STATUS_TERMINAL_NON_PUMK) s.add(t);
  return s;
}

describe("sebaran dunia demo (spec 13)", () => {
  test("proposal PUMK berjumlah 150 dengan 90 akad dicairkan", () => {
    expect(SEBARAN_STATUS.reduce((n, s) => n + s.jumlah, 0)).toBe(JUMLAH_PROPOSAL);
    expect(SEBARAN_STATUS.find((s) => s.status === "DICAIRKAN")?.jumlah).toBe(JUMLAH_AKAD);
  });

  test("setiap status di state machine PUMK punya data, termasuk yang ditolak", () => {
    const direncanakan = new Set(SEBARAN_STATUS.map((s) => s.status));
    for (const status of statusPumk()) {
      expect(direncanakan.has(status as never)).toBe(true);
    }
    // The two a happy-path seed always forgets.
    expect(direncanakan.has("DITOLAK")).toBe(true);
    expect(direncanakan.has("TIDAK_DIREKOMENDASIKAN")).toBe(true);
  });

  test("proposal Non PUMK berjumlah 60 dan menutup seluruh state machine", () => {
    expect(SEBARAN_NON_PUMK.reduce((n, s) => n + s.jumlah, 0)).toBe(JUMLAH_NON_PUMK);
    const direncanakan = new Set(SEBARAN_NON_PUMK.map((s) => s.status));
    for (const status of statusNonPumk()) {
      expect(direncanakan.has(status as never)).toBe(true);
    }
  });

  test("pengajuan portal berjumlah 25 di empat status", () => {
    const total = Object.values(SEBARAN_SUBMISSION).reduce((n, v) => n + v, 0);
    expect(total).toBe(JUMLAH_SUBMISSION);
    expect(Object.keys(SEBARAN_SUBMISSION).sort()).toEqual([
      "BARU",
      "DIKONVERSI",
      "DIPROSES",
      "DITOLAK",
    ]);
  });

  test("setiap proposal yang sampai akad memakai mitra yang berbeda", () => {
    // `pumk_akad_satu_aktif_per_mitra_uq` covers BELUM_CAIR too, so a mitra can
    // hold at most ONE akad in the whole world. A plan that hands two
    // akad-bearing proposals to one partner fails at the database, twenty
    // months into a replay, with a unique-violation nobody can read.
    const rencana = rencanakanPumk(mitraPalsu(JUMLAH_MITRA), 24, dadu(1));
    const berakad = rencana.filter((r) =>
      ["AKAD_DIBUAT", "JADWAL_SIAP", "DICAIRKAN"].includes(r.status),
    );
    expect(berakad).toHaveLength(JUMLAH_AKAD + 8);
    expect(new Set(berakad.map((r) => r.mitra.id)).size).toBe(berakad.length);
  });

  test("rencana bersifat deterministik: benih yang sama, dunia yang sama", () => {
    const a = rencanakanPumk(mitraPalsu(JUMLAH_MITRA), 24, dadu(7));
    const b = rencanakanPumk(mitraPalsu(JUMLAH_MITRA), 24, dadu(7));
    expect(a.map((r) => `${r.mitra.kode}|${r.status}|${r.pokok}|${r.bulanIdx}`)).toEqual(
      b.map((r) => `${r.mitra.kode}|${r.status}|${r.pokok}|${r.bulanIdx}`),
    );
  });

  test("pokok pinjaman selalu angka bulat yang masuk akal, bukan data uji", () => {
    const rencana = rencanakanPumk(mitraPalsu(JUMLAH_MITRA), 24, dadu(3));
    for (const r of rencana) {
      expect(r.pokok).toBeGreaterThanOrEqual(5_000_000);
      expect(r.pokok).toBeLessThanOrEqual(250_000_000);
      // Rounded to the nearest 500 thousand: what a survey recommendation looks
      // like, and never a computed remainder.
      expect(r.pokok % 500_000).toBe(0);
    }
  });

  test("setiap akad yang dicairkan muat di dalam jendela riwayat", () => {
    const rencana = rencanakanPumk(mitraPalsu(JUMLAH_MITRA), 24, dadu(5));
    for (const r of rencana) {
      expect(r.bulanIdx).toBeGreaterThanOrEqual(0);
      expect(r.bulanIdx).toBeLessThanOrEqual(23);
      expect(r.tenor + r.grace).toBeLessThanOrEqual(36);
    }
  });
});
