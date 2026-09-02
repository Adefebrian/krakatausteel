// THE THIRD OCCURRENCE IS A STRUCTURAL TRAP, NOT BAD LUCK.
//
// core/http.ts recognises a domain error STRUCTURALLY (a `name` plus a string
// `kode`) but only for names on an ALLOWLIST, `NAMA_ERROR_BERKODE`. That
// allowlist is what makes a refusal arrive as a 403/404/409 with its
// `kodeDomain` intact and, crucially, what makes `catatPenolakan` write the
// DITOLAK row spec 2 rule 5 requires: the handler only audits an error it can
// CLASSIFY.
//
// Three modules have now shipped a router whose error class was not on that
// list:
//   - modules/pumk, where every branch-scope refusal left the handler as an
//     anonymous 500 with no code and no audit row;
//   - modules/rka and modules/laporan, where the same thing happened again, so
//     spec 16 scenario 24 was passing on the engine and unenforced over HTTP;
//   - modules/closing, this one, caught before the routes were trusted.
//
// Each time it was found by hand. Each time the comment above the list grew
// another paragraph, and the next module repeated it anyway, because a comment
// is not a mechanism: nothing FAILED when a name was missing. The failure mode
// is uniquely bad -- a 500 with no code and no evidence, on precisely the
// refusals the audit rule exists for -- and uniquely quiet, because every
// engine test keeps passing and only an HTTP test that asserts a specific
// status can see it.
//
// SO THIS FILE IS THE MECHANISM. It sweeps apps/api/src/modules for every
// `export class *Error`, and fails if one of them is not registered. The next
// module to land a router does not have to remember; it will be told.
//
// WHY IT LIVES HERE AND NOT IN core/
// It belongs in core/, next to the list it guards, and it should move there
// when somebody owns that path. It is in this folder because that is where the
// third occurrence was found and because a repo-wide guard that exists is worth
// more than one that is correctly filed and never written. Nothing about it is
// specific to closing.
import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { NAMA_ERROR_BERKODE } from "../../core/http";
import { KODE_CLOSING } from "./contract";

const AKAR_MODUL = join(import.meta.dir, "..");

/** Every non-test .ts file under apps/api/src/modules. */
async function berkasModul(dir: string): Promise<string[]> {
  const entri = await readdir(dir, { withFileTypes: true });
  const keluar: string[] = [];
  for (const e of entri) {
    const penuh = join(dir, e.name);
    if (e.isDirectory()) {
      keluar.push(...(await berkasModul(penuh)));
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
      keluar.push(penuh);
    }
  }
  return keluar;
}

/**
 * `export class XxxError extends Error` -- the exact shape every engine here
 * declares its domain error with, and the shape core/http.ts matches on.
 * Deliberately narrow: a class that does not extend `Error` is not something
 * the handler would ever see thrown.
 */
const POLA_KELAS_ERROR = /export class (\w+Error)\s+extends\s+Error\b/g;

describe("setiap kelas error domain terdaftar di core/http.ts", () => {
  test("sapuan seluruh apps/api/src/modules tidak menemukan kelas yang belum terdaftar", async () => {
    const berkas = await berkasModul(AKAR_MODUL);
    const ditemukan = new Map<string, string>();
    for (const path of berkas) {
      const isi = await readFile(path, "utf8");
      for (const m of isi.matchAll(POLA_KELAS_ERROR)) {
        ditemukan.set(m[1]!, path.slice(AKAR_MODUL.length + 1));
      }
    }

    // The sweep must actually find things: a regex that silently stopped
    // matching would make this file pass forever while guarding nothing.
    expect(ditemukan.size).toBeGreaterThanOrEqual(7);
    expect([...ditemukan.keys()]).toContain("ClosingError");

    const belumTerdaftar = [...ditemukan.entries()]
      .filter(([nama]) => !NAMA_ERROR_BERKODE.has(nama))
      .map(([nama, path]) => `${nama} (${path})`);

    // The message is the whole point: whoever trips this must not have to
    // rediscover why it matters.
    expect(
      belumTerdaftar,
      "Kelas error domain di bawah ini belum terdaftar di NAMA_ERROR_BERKODE " +
        "(apps/api/src/core/http.ts). Selama belum terdaftar, setiap penolakan " +
        "yang dilemparkannya keluar sebagai 500 anonim tanpa kodeDomain DAN " +
        "tanpa baris DITOLAK di audit_log, karena error handler hanya mengaudit " +
        "error yang bisa diklasifikasikannya (spec 2 rule 5). Tambahkan namanya " +
        "ke set itu, lalu petakan kode-kodenya di KODE_KE_HTTP.",
    ).toEqual([]);
  });

  test("allowlist tidak berisi nama yang sudah tidak ada modulnya", async () => {
    // The other direction. A stale name is harmless at runtime but it is a lie
    // about what the handler covers, and it is how somebody concludes that a
    // module is handled when its class was renamed.
    const berkas = await berkasModul(AKAR_MODUL);
    const ada = new Set<string>();
    for (const path of berkas) {
      const isi = await readFile(path, "utf8");
      for (const m of isi.matchAll(POLA_KELAS_ERROR)) ada.add(m[1]!);
    }
    expect([...NAMA_ERROR_BERKODE].filter((nama) => !ada.has(nama))).toEqual([]);
  });
});

describe("kode ClosingError yang bukan 400 dipetakan secara eksplisit", () => {
  /**
   * Anything absent from `KODE_KE_HTTP` becomes a 400, which is the right
   * DEFAULT and the wrong answer for most of spec 8's refusals: they are states
   * the ledger is in, not fields the caller mistyped, and an identical retry
   * refuses identically.
   *
   * Listed here are the codes where 400 would be a LIE, with the status they
   * must produce. The three deliberately absent ones are named in the second
   * test, so "not listed" cannot be confused with "forgotten".
   */
  const HARUS_BUKAN_400: Readonly<Record<string, number>> = {
    PERIODE_TIDAK_DITEMUKAN: 404,
    CABANG_TIDAK_DITEMUKAN: 404,
    AKAD_TIDAK_DITEMUKAN: 404,
    PERIODE_TIDAK_OPEN: 409,
    PERIODE_SUDAH_CLOSED: 409,
    PERIODE_BELUM_CLOSED: 409,
    URUTAN_PERIODE: 409,
    REOPEN_BUKAN_PERIODE_TERAKHIR: 409,
    REOPEN_TIDAK_DIIZINKAN: 409,
    PRASYARAT_GAGAL: 409,
    KONFIRMASI_KAS_NEGATIF_WAJIB: 409,
    KOLEKTIBILITAS_BELUM_DIJALANKAN: 409,
    RANGE_KOLEKTIBILITAS_TIDAK_LENGKAP: 409,
    RANGE_KOLEKTIBILITAS_TUMPANG_TINDIH: 409,
    RATE_PENYISIHAN_TIDAK_ADA: 409,
    HISTORI_TIDAK_CUKUP: 409,
    KONFIGURASI_TIDAK_ADA: 409,
    KONFIGURASI_TIDAK_VALID: 409,
    EVENT_MAPPING_BELUM_ADA: 409,
    SKEMA_BELUM_LENGKAP: 409,
    JURNAL_GAGAL: 409,
    TIDAK_BERWENANG: 403,
    CABANG_DILUAR_SCOPE: 403,
    IZIN_BELUM_TERDAFTAR: 403,
  };

  /** The codes that ARE about the body, and are therefore correctly a 400. */
  const SENGAJA_400 = ["ALASAN_WAJIB", "NILAI_BUKAN_DESIMAL", "TANGGAL_TIDAK_VALID"] as const;

  test("setiap kode closing diputuskan: dipetakan, atau sengaja dibiarkan 400", () => {
    const semua = Object.values(KODE_CLOSING) as string[];
    const diputuskan = new Set([...Object.keys(HARUS_BUKAN_400), ...SENGAJA_400]);
    // A new code added to KODE_CLOSING without a decision here would silently
    // become a 400. That is survivable for a validation and wrong for a state
    // refusal, and the difference is exactly what an accountant reads off the
    // status.
    expect(semua.filter((k) => !diputuskan.has(k))).toEqual([]);
  });

  test("pemetaan itu benar benar berlaku di error handler", async () => {
    // Asserted against the REAL handler rather than against the table, because
    // the table is only half of it: the name has to be on the allowlist too,
    // and it is precisely that half that has been forgotten three times.
    const { createErrorHandler } = await import("../../core/http");
    const { ClosingError } = await import("./contract");
    const handler = createErrorHandler();

    for (const [kode, status] of Object.entries(HARUS_BUKAN_400)) {
      const err = new ClosingError(
        kode as keyof typeof KODE_CLOSING,
        "Penolakan uji pemetaan kode closing.",
      );
      const c = {
        req: { method: "POST", path: "/closing/uji" },
        json: (body: unknown, s?: number) =>
          new Response(JSON.stringify(body), { status: s ?? 200 }),
        get: () => undefined,
        set: () => undefined,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = (await handler(err, c as any)) as Response;
      const body = (await res.json()) as { code: string; kodeDomain?: string };
      expect({ kode, status: res.status, kodeDomain: body.kodeDomain }).toEqual({
        kode,
        status,
        kodeDomain: kode,
      });
      // And it never leaks the trigger text or a constraint name.
      expect(body.code).not.toBe("KESALAHAN_SERVER");
    }
  });
});
