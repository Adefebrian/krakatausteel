// Hono router for /rka (spec 9.3, and spec 10.3 report 24). The HTTP surface
// of the budget line: the three entry screens (RKA PUMK per sektor, RKA Non
// PUMK per bidang, RKA Keuangan per akun), the versions with their DRAFT,
// DISETUJUI and REVISI status, the approval that makes one version THE
// baseline, and the RKA versus Realisasi report measured against it.
//
// IT FOLLOWS modules/pumk/routes.ts AND modules/nonpumk/routes.ts DELIBERATELY.
// Those two landed first, the problem is the same, and the parts that are easy
// to get wrong are already solved there. The five rules they state are restated
// here because they are what this file is FOR:
//
//   VALIDATE at the boundary. Every handler parses and checks its input BEFORE
//   any engine call, and answers `400 VALIDASI` with per-field detail,
//   collecting EVERY bad field into one response so a budget grid is not
//   submitted five times to learn five problems. The engine validates again --
//   it is reachable from a seed and from a later batch -- so this is the first
//   line, not the only one. Hand written rather than zod, because this repo
//   carries no schema library and modules/konfigurasi, modules/pumk and
//   modules/nonpumk all validate this way: adding a dependency is an API-WIDE
//   decision, not one this module gets to make on its own.
//
//   AUTHORISE with `requirePermission`, using CANONICAL codes from
//   modules/auth's catalogue. An unknown code throws at ROUTE-REGISTRATION
//   time (`resolveRequiredPermissions`), so a typo is a boot failure and never
//   a 403 that reads like policy. All four codes this file names are SHIPPED:
//   `admin.rka` enters a budget (ADMIN_PUSAT), `admin.rka.approve` approves one
//   (ADMIN_PUSAT), `admin.rka.view` reads one (AUDITOR, and ADMIN_CABANG scoped
//   to its own branch), and `laporan.view` opens report 24 (every role).
//
//   NEVER DECIDE BRANCH SCOPE. Not one handler reads a `cabangId` from the
//   request and uses it as authority. `konteks()` carries the branches the
//   SESSION resolved; the engine compares them against the branch the ROW
//   reports, so a manipulated id in the URL selects a row that refuses on its
//   own evidence (spec 2 rule 3, spec 16 scenario 24). The two places a branch
//   arrives in a request are `POST /rka`, where no row exists yet to read it
//   from, and the list and report FILTERS, which the engine intersects with the
//   session's visible set rather than trusting.
//
//   NEVER CATCH A DOMAIN ERROR. `RkaError` travels to core/http.ts's handler,
//   which maps each code onto its HTTP status, keeps the code in the body as
//   `kodeDomain` and writes the DITOLAK audit row spec 2 rule 5 requires. A
//   try/catch here would turn a precise refusal into an anonymous 500 with no
//   audit trail -- which is exactly what happened until `RkaError` was added to
//   that handler's allowlist alongside this router.
//
//   NEVER MUTATE ON GET. Read-only roles are refused every non-GET by the
//   global guard in core/app.ts before any of this runs; that guarantee is
//   worth nothing if a GET writes.
//
// THIS MODULE CANNOT REACH THE LEDGER, and no route here changes that. The
// engine takes no journal port at all (see ./contract.ts): an RKA is a target,
// not a transaction. Nothing below posts, and nothing below may be made to.
//
// ONE THING SPECIFIC TO REPORT 24. `GET /rka/laporan/realisasi` accepts a
// version to compare against, because spec 9.3 says the report may choose one.
// It does NOT accept which SOURCE the realisation is read from: an OPEN month
// is read live from `v_ledger_baris` and a CLOSED one from the frozen
// `saldo_akun_periode`, the engine decides that per month from the period's own
// status, and letting a caller override it would let somebody produce a live
// figure for a closed month and present it as the budget outturn. The answer
// carries `sumberPerPeriode` so the page can SHOW which source answered, which
// is the legitimate need behind the illegitimate parameter.
import { Hono } from "hono";
import { badRequest, notFound } from "../../core/http";
import { requirePrincipal, type Guards, type Principal } from "../../core/principal";
import type {
  BarisRkaInput,
  JenisRka,
  ModeLaporanRka,
  RkaContext,
  RkaEngine,
  StatusRka,
} from "./contract";
import type { RkaBaca } from "./baca";

export interface RkaRoutesDeps {
  engine: RkaEngine;
  baca: RkaBaca;
  guards: Guards;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * The session's own authority, translated into what the engine takes. Nothing
 * from the request reaches this: `cabangId` is the user's home branch and
 * `cabangDalamScope` is what the session resolved, so a caller cannot widen
 * their own scope by sending a branch id.
 */
function konteks(principal: Principal): RkaContext {
  return {
    userId: principal.userId,
    cabangId: principal.cabang.id,
    bumnId: principal.bumnId,
    permissions: principal.permissions,
    cabangDalamScope: principal.cabangTersedia.map((cabang) => cabang.id),
  };
}

// ---------------------------------------------------------------------------
// Boundary validation
// ---------------------------------------------------------------------------

/** `jumlah_anggaran` is NUMERIC(20,2) and arrives as fixed two-decimal text. */
const POLA_UANG = /^\d{1,18}\.\d{2}$/;
const POLA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_TEKS = 2000;
/**
 * A budget grid, capped. Twelve months across the widest dimension list a
 * client has is comfortably inside this; a request above it is a paste
 * accident or an attempt to make one transaction hold the whole database.
 */
const MAX_BARIS = 5000;
/** `rka.tahun` is a financial year, not a timestamp. */
const TAHUN_MIN = 2000;
const TAHUN_MAX = 2100;

class Pemeriksa {
  private readonly galat: Record<string, string[]> = {};

  private tolak(field: string, pesan: string): void {
    (this.galat[field] ??= []).push(pesan);
  }

  wajibUuid(nilai: unknown, field: string): string {
    if (typeof nilai !== "string" || !POLA_UUID.test(nilai)) {
      this.tolak(field, "wajib berupa UUID");
      return "";
    }
    return nilai;
  }

  opsionalUuid(nilai: unknown, field: string): string | null {
    if (nilai === undefined || nilai === null || nilai === "") return null;
    return this.wajibUuid(nilai, field);
  }

  /**
   * Money as TEXT, never `Number()`. A budget is compared against a realisation
   * in SEN, and a figure that made a round trip through a float can miss a
   * comparison an accountant watched succeed on their own screen.
   */
  wajibUang(nilai: unknown, field: string): string {
    if (typeof nilai !== "string" || !POLA_UANG.test(nilai)) {
      this.tolak(field, "wajib desimal dua angka di belakang koma, misalnya 1500000.00");
      return "0.00";
    }
    return nilai;
  }

  wajibTahun(nilai: unknown, field: string): number {
    if (
      typeof nilai !== "number" ||
      !Number.isInteger(nilai) ||
      nilai < TAHUN_MIN ||
      nilai > TAHUN_MAX
    ) {
      this.tolak(field, `wajib tahun antara ${TAHUN_MIN} dan ${TAHUN_MAX}`);
      return TAHUN_MIN;
    }
    return nilai;
  }

  /** Same bounds, from a query string, where every value is text. */
  opsionalTahunTeks(nilai: string | null, field: string): number | null {
    if (nilai === null) return null;
    const angka = Number(nilai);
    if (!Number.isInteger(angka) || angka < TAHUN_MIN || angka > TAHUN_MAX) {
      this.tolak(field, `wajib tahun antara ${TAHUN_MIN} dan ${TAHUN_MAX}`);
      return null;
    }
    return angka;
  }

  /**
   * Mandatory on the report and on the baseline lookup, and collected into the
   * SAME 400 as every other bad field rather than thrown on sight: a form that
   * is missing a year and has a malformed branch id deserves to learn both at
   * once.
   */
  wajibTahunTeks(nilai: string | null, field: string): number {
    if (nilai === null) {
      this.tolak(field, "wajib diisi");
      return TAHUN_MIN;
    }
    return this.opsionalTahunTeks(nilai, field) ?? TAHUN_MIN;
  }

  /** ISO date, as TEXT. `approved_at` is stamped from the injected clock when
   *  this is absent, so it is optional and never invented here. */
  opsionalTanggal(nilai: unknown, field: string): string | null {
    if (nilai === undefined || nilai === null || nilai === "") return null;
    if (typeof nilai !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(nilai)) {
      this.tolak(field, "wajib tanggal dengan format YYYY-MM-DD");
      return null;
    }
    return nilai;
  }

  wajibBulanTeks(nilai: string | null, field: string): number {
    const angka = nilai === null ? Number.NaN : Number(nilai);
    if (!Number.isInteger(angka) || angka < 1 || angka > 12) {
      this.tolak(field, "wajib bulan 1 sampai 12");
      return 1;
    }
    return angka;
  }

  opsionalVersiTeks(nilai: string | null, field: string): number | null {
    if (nilai === null) return null;
    const angka = Number(nilai);
    if (!Number.isInteger(angka) || angka < 1 || angka > 1000) {
      this.tolak(field, "wajib nomor versi bulat positif");
      return null;
    }
    return angka;
  }

  /** 1..12, or null for an annual figure with no monthly breakdown. */
  bulanBaris(nilai: unknown, field: string): number | null {
    if (nilai === undefined || nilai === null || nilai === "") return null;
    if (typeof nilai !== "number" || !Number.isInteger(nilai) || nilai < 1 || nilai > 12) {
      this.tolak(field, "wajib bulan 1 sampai 12, atau kosong untuk angka tahunan");
      return null;
    }
    return nilai;
  }

  opsionalCacah(nilai: unknown, field: string, maks = 10_000_000): number | null {
    if (nilai === undefined || nilai === null || nilai === "") return null;
    if (typeof nilai !== "number" || !Number.isInteger(nilai) || nilai < 0 || nilai > maks) {
      this.tolak(field, `wajib bilangan bulat antara 0 dan ${maks}`);
      return null;
    }
    return nilai;
  }

  wajibTeks(nilai: unknown, field: string, maks = MAX_TEKS): string {
    if (typeof nilai !== "string" || nilai.trim() === "" || nilai.length > maks) {
      this.tolak(field, `wajib teks, maksimal ${maks} karakter`);
      return "";
    }
    return nilai;
  }

  opsionalTeks(nilai: unknown, field: string, maks = MAX_TEKS): string | null {
    if (nilai === undefined || nilai === null || nilai === "") return null;
    if (typeof nilai !== "string" || nilai.length > maks) {
      this.tolak(field, `wajib teks, maksimal ${maks} karakter`);
      return null;
    }
    return nilai;
  }

  wajibPilihan<T extends string>(nilai: unknown, field: string, pilihan: readonly T[]): T {
    if (typeof nilai !== "string" || !(pilihan as readonly string[]).includes(nilai)) {
      this.tolak(field, `wajib salah satu dari: ${pilihan.join(", ")}`);
      return pilihan[0] as T;
    }
    return nilai as T;
  }

  opsionalPilihan<T extends string>(
    nilai: unknown,
    field: string,
    pilihan: readonly T[],
  ): T | null {
    if (nilai === undefined || nilai === null || nilai === "") return null;
    return this.wajibPilihan(nilai, field, pilihan);
  }

  opsionalBoolean(nilai: unknown, field: string, bawaan: boolean): boolean {
    if (nilai === undefined || nilai === null || nilai === "") return bawaan;
    if (nilai === true || nilai === "true") return true;
    if (nilai === false || nilai === "false") return false;
    this.tolak(field, "wajib true atau false");
    return bawaan;
  }

  /**
   * The budget grid. SHAPE only: whether a sektor EXISTS, whether an account
   * may be budgeted at all, and whether the dimension matches the budget type
   * are DATABASE questions and belong to the engine
   * (`DIMENSI_TIDAK_SESUAI_JENIS`, `AKUN_TIDAK_DAPAT_DIANGGARKAN`,
   * `SEKTOR_TIDAK_DITEMUKAN`). What is checked here is that each row is an
   * object with a description, a legal month and a well formed amount, so a
   * grid comes back with the offending CELL named rather than one code for the
   * whole submission.
   */
  daftarBaris(nilai: unknown, field: string): BarisRkaInput[] {
    if (nilai === undefined || nilai === null) return [];
    if (!Array.isArray(nilai) || nilai.length > MAX_BARIS) {
      this.tolak(field, `wajib daftar baris anggaran, maksimal ${MAX_BARIS} baris`);
      return [];
    }
    const keluar: BarisRkaInput[] = [];
    for (const [i, item] of nilai.entries()) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        this.tolak(`${field}[${i}]`, "wajib objek baris anggaran");
        continue;
      }
      const b = item as Record<string, unknown>;
      keluar.push({
        akunId: this.opsionalUuid(b.akunId, `${field}[${i}].akunId`),
        sektorId: this.opsionalUuid(b.sektorId, `${field}[${i}].sektorId`),
        bidangId: this.opsionalUuid(b.bidangId, `${field}[${i}].bidangId`),
        uraian: this.wajibTeks(b.uraian, `${field}[${i}].uraian`, 300),
        bulan: this.bulanBaris(b.bulan, `${field}[${i}].bulan`),
        jumlahAnggaran: this.wajibUang(b.jumlahAnggaran, `${field}[${i}].jumlahAnggaran`),
        jumlahUnit: this.opsionalCacah(b.jumlahUnit, `${field}[${i}].jumlahUnit`),
        keterangan: this.opsionalTeks(b.keterangan, `${field}[${i}].keterangan`, 500),
      });
    }
    return keluar;
  }

  selesai(): void {
    if (Object.keys(this.galat).length > 0) {
      throw badRequest("Data yang dikirim belum valid", this.galat);
    }
  }
}

/** The body, as an object. A non-object body is an empty one, not a crash. */
async function tubuh(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown>> {
  const parsed = await c.req.json().catch(() => null);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

/** A query-string filter value, trimmed and length-capped, or null. */
function q(nilai: string | undefined, maks = 200): string | null {
  if (nilai === undefined) return null;
  const bersih = nilai.trim();
  if (bersih === "") return null;
  return bersih.slice(0, maks);
}

// ---------------------------------------------------------------------------
// Vocabularies the boundary accepts. Each mirrors a CHECK constraint in
// migrations/0012_rka.sql or a union in ./contract.ts, so a value this file
// lets through is one the database would also accept.
// ---------------------------------------------------------------------------

const JENIS_RKA = ["PUMK", "NON_PUMK", "KEUANGAN"] as const;
const STATUS_RKA = ["DRAFT", "DISETUJUI", "REVISI"] as const;
const MODE_LAPORAN = ["BULANAN", "KUMULATIF_YTD"] as const;

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export function createRkaRoutes({ engine, baca, guards }: RkaRoutesDeps) {
  const { requireSession, requirePermission, rejectReadOnlyMutation } = guards;

  /**
   * Read guards. `admin.rka.view` and NOT `laporan.view`: the budget entry
   * screens of spec 9.3 are not among spec 10's 31 reports, so a role that may
   * open report 24 does not thereby get to read the versions it compares
   * against. AUDITOR and ADMIN_CABANG hold it, which is what makes the branch
   * scope check on these reads reachable at all.
   */
  const lihat = [requireSession, requirePermission("admin.rka.view")] as const;

  /**
   * Report 24 is one of spec 10's reports, so it is gated by the code that
   * gates the report catalogue, which every role holds. That is spec 16
   * scenario 23: an Auditor opens it and finds nothing that writes.
   */
  const laporan = [requireSession, requirePermission("laporan.view")] as const;

  /**
   * Write guards. `rejectReadOnlyMutation` is belt and braces: the same check
   * already ran globally in core/app.ts, and it stays here so this router is
   * still safe if it is ever mounted somewhere that forgot.
   */
  const ubah = (...izin: string[]) =>
    [requireSession, rejectReadOnlyMutation, requirePermission(...izin)] as const;

  return new Hono()
    // ------------------------------------------------------------ referensi
    //
    // What an entry screen loads before it can be filled in: the dimension
    // this budget type is entered against and its rows, the branches this
    // caller may budget for, and the month the financial year starts in. All
    // four answer from master data and configuration, never from a literal in
    // this repo.
    .get("/referensi", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const jenis = cek.wajibPilihan(q(c.req.query("jenis")), "jenis", JENIS_RKA) as JenisRka;
      cek.selesai();
      return c.json(await baca.referensi(jenis, konteks(p)));
    })

    // The month picker report 24 needs, and the status of each month, which is
    // what tells a reader whether a figure will be live or frozen.
    .get("/periode", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const tahun = cek.opsionalTahunTeks(q(c.req.query("tahun")), "tahun");
      cek.selesai();
      return c.json({ data: await baca.daftarPeriode({ tahun }, konteks(p)) });
    })

    // ------------------------------------------------------- report 24 first
    //
    // Registered BEFORE `/:id`, because `/laporan` would otherwise be matched
    // as a budget id and answered with a 400 about UUID format.
    //
    // `cabangId` is accepted as a FILTER and is not authority: the engine
    // REFUSES a branch outside the caller's scope rather than emptying the
    // answer, because an empty report reads as "that branch spent nothing",
    // which is a wrong answer presented as a right one.
    //
    // There is deliberately no parameter for the realisation SOURCE. See this
    // file's header.
    .get("/laporan/realisasi", ...laporan, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const filter = {
        tahun: cek.wajibTahunTeks(q(c.req.query("tahun")), "tahun"),
        jenis: cek.wajibPilihan(q(c.req.query("jenis")), "jenis", JENIS_RKA) as JenisRka,
        cabangId: cek.opsionalUuid(q(c.req.query("cabangId")), "cabangId"),
        versi: cek.opsionalVersiTeks(q(c.req.query("versi")), "versi"),
        rkaId: cek.opsionalUuid(q(c.req.query("rkaId")), "rkaId"),
        mode: cek.wajibPilihan(
          q(c.req.query("mode")) ?? "BULANAN",
          "mode",
          MODE_LAPORAN,
        ) as ModeLaporanRka,
        bulan: cek.wajibBulanTeks(q(c.req.query("bulan")), "bulan"),
      };
      cek.selesai();
      return c.json(await engine.laporanRkaVsRealisasi(filter, konteks(p)));
    })

    /**
     * Which source report 24 WOULD use, without running it. Exists so a screen
     * can grey the button rather than show an error after the click:
     * `saldo_akun_periode` is keyed (periode, cabang, akun) and carries no
     * sektor and no bidang, so a CLOSED period has no frozen per-sector figure
     * and the engine answers `TIDAK_TERSEDIA` instead of re-deriving one from
     * editable master data.
     */
    .get("/laporan/metode-realisasi", ...laporan, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const periodeId = cek.wajibUuid(q(c.req.query("periodeId")), "periodeId");
      const jenis = cek.wajibPilihan(q(c.req.query("jenis")), "jenis", JENIS_RKA) as JenisRka;
      cek.selesai();
      return c.json({ metode: await engine.metodeRealisasi({ periodeId, jenis }, konteks(p)) });
    })

    // ------------------------------------------------------------------- RKA
    //
    /**
     * The list. `cabangId` is a FILTER the engine INTERSECTS with the branches
     * the session resolved, so naming another branch narrows the answer or
     * empties it, and never widens it (spec 16 scenario 24).
     *
     * TWO DIFFERENT ABSENCES, AND THEY ARE NOT THE SAME REQUEST. In `FilterRka`
     * an ABSENT `cabangId` means "no branch filter" and an explicit `null`
     * means "consolidated budgets only" (`cabang_id IS NULL`), which is a real
     * filter a screen needs, because an entity-wide budget is a different
     * document from a branch one. A query string cannot carry that difference
     * on its own -- an absent parameter and an empty one arrive identically --
     * so the consolidated filter is its own boolean, `konsolidasi=true`, and
     * the key is OMITTED rather than passed as null when neither is sent.
     * Passing null for an absent parameter silently answered every list with
     * the consolidated budgets alone.
     */
    .get("/", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const cabangId = cek.opsionalUuid(q(c.req.query("cabangId")), "cabangId");
      const konsolidasi = cek.opsionalBoolean(
        q(c.req.query("konsolidasi")),
        "konsolidasi",
        false,
      );
      const filter = {
        tahun: cek.opsionalTahunTeks(q(c.req.query("tahun")), "tahun"),
        jenis: cek.opsionalPilihan(q(c.req.query("jenis")), "jenis", JENIS_RKA) as JenisRka | null,
        status: cek.opsionalPilihan(
          q(c.req.query("status")),
          "status",
          STATUS_RKA,
        ) as StatusRka | null,
        ...(konsolidasi ? { cabangId: null } : cabangId !== null ? { cabangId } : {}),
      };
      cek.selesai();
      return c.json({ data: await engine.daftarRka(filter, konteks(p)) });
    })

    /**
     * The approved version in force for a scope, or null. Spec 9.3's "baseline
     * pembanding", resolved in ONE place so report 24 and the future reports 2
     * and 13 cannot disagree about which document a branch is measured against.
     *
     * Registered before `/:id` for the same routing reason `/laporan` is.
     */
    .get("/baseline", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const tahun = cek.wajibTahunTeks(q(c.req.query("tahun")), "tahun");
      const jenis = cek.wajibPilihan(q(c.req.query("jenis")), "jenis", JENIS_RKA) as JenisRka;
      const cabangId = cek.opsionalUuid(q(c.req.query("cabangId")), "cabangId");
      cek.selesai();
      return c.json({ data: await engine.baseline({ tahun, jenis, cabangId }, konteks(p)) });
    })

    /**
     * Creates version 1 for (cabang, tahun, jenis) as a DRAFT, optionally with
     * its grid in the same call.
     *
     * `cabangId` is validated as a SHAPE only, and `null` is a consolidated,
     * entity-wide budget rather than a missing field. Whether this caller may
     * budget for that branch is the ENGINE's decision, against the session's
     * scope. This is the one payload in the module that names a branch,
     * because there is no row yet to read one from.
     */
    .post("/", ...ubah("admin.rka"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const input = {
        cabangId: cek.opsionalUuid(b.cabangId, "cabangId"),
        tahun: cek.wajibTahun(b.tahun, "tahun"),
        jenis: cek.wajibPilihan(b.jenis, "jenis", JENIS_RKA) as JenisRka,
        keterangan: cek.opsionalTeks(b.keterangan, "keterangan", 500),
        baris: cek.daftarBaris(b.baris, "baris"),
      };
      cek.selesai();
      return c.json(await engine.buatRka(input, konteks(p)), 201);
    })

    .get("/:id", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const id = cek.wajibUuid(c.req.param("id"), "id");
      cek.selesai();
      return c.json(await engine.bacaRka(id, konteks(p)));
    })

    /**
     * REPLACES the grid of a DRAFT version, whole. Not a per-row patch: a
     * budget is entered as a grid and saved as a grid, and a partial update is
     * how a row silently survives a revision nobody meant to keep.
     *
     * An approved version refuses this with `RKA_SUDAH_DISETUJUI`. That is spec
     * 9.3's rule ("a change makes a NEW version") and it is enforced in the
     * engine rather than duplicated here, so the two cannot drift.
     */
    .post("/:id/baris", ...ubah("admin.rka"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      // The id in the URL is authoritative over any id in the body, so a body
      // that names a different version cannot act on it.
      const rkaId = cek.wajibUuid(c.req.param("id"), "id");
      const baris = cek.daftarBaris(b.baris, "baris");
      cek.selesai();
      return c.json(await engine.simpanBaris({ rkaId, baris }, konteks(p)));
    })

    /**
     * DRAFT -> DISETUJUI, and the outgoing baseline -> REVISI, in one
     * transaction.
     *
     * `admin.rka.approve`, deliberately NOT `admin.rka`. Spec 2 separates the
     * authority to INPUT from the authority to APPROVE everywhere else the two
     * exist, and with one code the person who types the sector targets is the
     * person who blesses them. Holding the code is still not the whole control:
     * ADMIN_PUSAT holds both, so whether the drafter may also approve is
     * decided by `rka.pemisahan_tugas_persetujuan`, which the engine reads.
     */
    .post("/:id/setujui", ...ubah("admin.rka.approve"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const rkaId = cek.wajibUuid(c.req.param("id"), "id");
      const input = {
        rkaId,
        tanggal: cek.opsionalTanggal(b.tanggal, "tanggal"),
        catatan: cek.opsionalTeks(b.catatan, "catatan", 500),
      };
      cek.selesai();
      return c.json(await engine.setujuiRka(input, konteks(p)));
    })

    /**
     * Opens the NEXT version as a DRAFT from an approved one. The source
     * version is left EXACTLY as it is -- still DISETUJUI, still the baseline,
     * still readable with every line intact -- until the new one is approved.
     *
     * `salinBaris` defaults to true: a revision is almost always an edit of the
     * numbers in force, and an empty grid invites re-keying a budget that
     * already exists.
     */
    .post("/:id/revisi", ...ubah("admin.rka"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const rkaId = cek.wajibUuid(c.req.param("id"), "id");
      const input = {
        rkaId,
        keterangan: cek.opsionalTeks(b.keterangan, "keterangan", 500),
        salinBaris: cek.opsionalBoolean(b.salinBaris, "salinBaris", true),
      };
      cek.selesai();
      return c.json(await engine.buatRevisi(input, konteks(p)), 201);
    })

    // A 404 that is the API's own, in the API's own envelope, rather than
    // Hono's plain-text default: apps/web/src/api/http.ts branches on the JSON
    // body and a bare text 404 would be reported as "the server did not
    // answer" instead of "that path does not exist".
    .all("/*", () => {
      throw notFound("Endpoint RKA tidak ditemukan");
    });
}
