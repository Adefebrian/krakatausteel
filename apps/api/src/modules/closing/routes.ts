// Hono router for /closing (spec 8, and spec 9.3's two Admin screens). The HTTP
// surface of the monthly close: the kolektibilitas classification with its
// mandatory preview, the allowance and the accrual, the ten-item prerequisite
// checklist, the close itself, the reopen, and the frozen trial balance a
// closed month is read from afterwards.
//
// IT FOLLOWS modules/rka/routes.ts, modules/laporan/routes.ts,
// modules/pumk/routes.ts AND modules/nonpumk/routes.ts DELIBERATELY. Four
// modules have solved this shape; the parts that are easy to get wrong are
// already solved there. The five rules they state are restated here because
// they are what this file is FOR:
//
//   VALIDATE at the boundary. Every handler parses and checks its input BEFORE
//   any engine call, and answers `400 VALIDASI` with per-field detail,
//   collecting EVERY bad field into one response. The engine validates again --
//   it is reachable from a batch job and from this folder's own fixtures -- so
//   this is the first line, not the only one. Hand written rather than zod,
//   because this repo carries no schema library and five other modules validate
//   this way: adding a dependency is an API-WIDE decision, not one this module
//   gets to make on its own.
//
//   AUTHORISE with `requirePermission`, using CANONICAL codes from modules/auth's
//   catalogue. An unknown code throws at ROUTE-REGISTRATION time
//   (`resolveRequiredPermissions`), so a typo is a boot failure and never a 403
//   that reads like policy. All four codes this file names are SHIPPED and each
//   is deliberate:
//     `admin.closing.kolektibilitas`  runs and previews the classification;
//     `admin.closing.periode`         runs the allowance, the accrual and the
//                                     close;
//     `admin.periode.reopen`          reopens a closed period, ADMIN_PUSAT only;
//     `admin.closing.view`            READS the checklist, the run history, the
//                                     snapshot and the frozen balances, WITHOUT
//                                     the right to run anything.
//   That last one is spec 16 scenario 23 made structural: how a period was
//   closed, and against which checklist, is the Auditor's primary object, and
//   it is not one of spec 10's 31 reports so `laporan.view` does not reach it.
//   Without a read-only code the only options were to hand a write code to a
//   role that must never write, or to lock the auditor out of the evidence.
//
//   NEVER DECIDE BRANCH SCOPE. Not one handler reads a `cabangId` from the
//   request and uses it as authority. `konteks()` carries the branches the
//   SESSION resolved; the engine compares them against the branch the ROW
//   reports, so a manipulated id in the URL selects a row that refuses on its
//   own evidence (spec 2 rule 3, spec 16 scenario 24). `cabangId` appears in a
//   body or a query only as a NARROWING filter, and the engine REFUSES one
//   outside the caller's scope rather than quietly emptying the answer.
//
//   NEVER CATCH A DOMAIN ERROR. `ClosingError` travels to core/http.ts's
//   handler, which maps each code onto its HTTP status, keeps the code in the
//   body as `kodeDomain` and writes the DITOLAK audit row spec 2 rule 5
//   requires. That matters more here than anywhere: this module's refusals ARE
//   its product. "A journal is still DRAFT", "February is still open", "the
//   sub-ledger disagrees with the general ledger", "cash is negative and you
//   have not confirmed it" and "that is not the latest closed period" are each
//   a specific thing an accountant must act on, and a try/catch here would
//   flatten all of them into one anonymous 500 with no audit row. `ClosingError`
//   was NOT in that handler's allowlist when this router was written; it is now,
//   and it had to be added before a single route could be trusted.
//
//   NEVER MUTATE ON GET. Every GET below is a SELECT, including the checklist,
//   which the screen runs on every page load and which writes nothing at all --
//   not even a CLOSING_IN_PROGRESS marker.
//
// THREE THINGS SPECIFIC TO A CLOSING SURFACE:
//
//   THE PREVIEW MUST BE IMPOSSIBLE TO CONFUSE WITH THE COMMIT. Spec 8.1 makes
//   preview mode mandatory, and the difference between the two is a whole
//   month's snapshots. They are separated FOUR ways here: a different PATH
//   (`.../kolektibilitas/pratinjau` vs `.../kolektibilitas`), a different
//   STATUS (200 for a computation, 201 for a run that was created), a different
//   BODY (`tersimpan: false` vs `tersimpan: true`, a literal type in
//   ./contract.ts so the two cannot be assigned to each other), and no flag on
//   either route that could flip it into the other. There is deliberately no
//   `?commit=true`: a boolean is one typo away from writing a month.
//
//   THE CHECKLIST IS ALWAYS ALL TEN. The engine never short-circuits, and this
//   router never filters: an operator needs to know how much work is left, not
//   which item happened to fail first.
//
//   THE CLOSE IS NOT RETRIED, EVER. `tutupPeriode` takes a row lock on the
//   period and holds it to COMMIT so two concurrent closes produce exactly one
//   success. A retry here -- on a 409, on a lock timeout, on anything -- would
//   hand the loser of that race a second attempt against a period the winner
//   has already closed, and turn a correct refusal into a second SUKSES audit
//   row for a month that was closed once. Nothing below retries anything.
import { Hono } from "hono";
import { badRequest, notFound } from "../../core/http";
import { requirePrincipal, type Guards, type Principal } from "../../core/principal";
import type {
  ClosingContext,
  ClosingEngine,
  StatusPeriode,
} from "./contract";
import type { ClosingBaca } from "./baca";

export interface ClosingRoutesDeps {
  engine: ClosingEngine;
  baca: ClosingBaca;
  guards: Guards;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * The session's own authority, translated into what the engine takes. Nothing
 * from the request reaches this: `cabangId` is the user's home branch and
 * `cabangDalamScope` is what the session resolved, so a caller cannot widen
 * their own scope by sending a branch id, and `userId` is what `closed_by` and
 * `reopened_by` are stamped from.
 */
function konteks(principal: Principal): ClosingContext {
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

const POLA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TAHUN_MIN = 2000;
const TAHUN_MAX = 2100;

/**
 * `alasan_reopen` is TEXT and the reason is read by an auditor months later, so
 * it needs room; it is still capped, because an unbounded field on the heaviest
 * privilege in the system is a way to make one request hold a book.
 */
const MAX_ALASAN = 2000;
/** Long enough that "ok" or "." cannot pass as a written reason (spec 8.4). */
const MIN_ALASAN = 10;

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

  opsionalTahunTeks(nilai: string | null, field: string): number | null {
    if (nilai === null) return null;
    const angka = Number(nilai);
    if (!Number.isInteger(angka) || angka < TAHUN_MIN || angka > TAHUN_MAX) {
      this.tolak(field, `wajib tahun antara ${TAHUN_MIN} dan ${TAHUN_MAX}`);
      return null;
    }
    return angka;
  }

  opsionalPilihan<T extends string>(
    nilai: unknown,
    field: string,
    pilihan: readonly T[],
  ): T | null {
    if (nilai === undefined || nilai === null || nilai === "") return null;
    if (typeof nilai !== "string" || !(pilihan as readonly string[]).includes(nilai)) {
      this.tolak(field, `wajib salah satu dari: ${pilihan.join(", ")}`);
      return null;
    }
    return nilai as T;
  }

  /**
   * Strictly boolean, and never "any truthy value". `konfirmasiKasNegatif` is a
   * deliberate act recorded in the audit log (spec 8.4 check 8), so a body that
   * says `"maybe"` must be a 400 rather than a confirmation nobody made.
   */
  opsionalBoolean(nilai: unknown, field: string, bawaan: boolean): boolean {
    if (nilai === undefined || nilai === null || nilai === "") return bawaan;
    if (nilai === true || nilai === "true") return true;
    if (nilai === false || nilai === "false") return false;
    this.tolak(field, "wajib true atau false");
    return bawaan;
  }

  /**
   * The reopen reason. Checked HERE as well as in the engine, with a minimum
   * length the engine does not impose, because this is the boundary an operator
   * types at: `ALASAN_WAJIB` from the engine means "blank", and a reason of "x"
   * is not blank and is not a reason either. The engine stays the authority on
   * blankness so a batch caller cannot bypass the rule; this adds the shape a
   * form owes its user.
   */
  wajibAlasan(nilai: unknown, field: string): string {
    if (typeof nilai !== "string") {
      this.tolak(field, `wajib teks alasan, ${MIN_ALASAN} sampai ${MAX_ALASAN} karakter`);
      return "";
    }
    const bersih = nilai.trim();
    if (bersih.length < MIN_ALASAN || bersih.length > MAX_ALASAN) {
      this.tolak(field, `wajib teks alasan, ${MIN_ALASAN} sampai ${MAX_ALASAN} karakter`);
      return "";
    }
    return bersih;
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

/**
 * Mirrors the CHECK constraint on `periode.status` in migrations/0007, so a
 * value this file lets through is one the database would also accept.
 */
const STATUS_PERIODE = ["OPEN", "CLOSING_IN_PROGRESS", "CLOSED"] as const;

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export function createClosingRoutes({ engine, baca, guards }: ClosingRoutesDeps) {
  const { requireSession, requirePermission, rejectReadOnlyMutation } = guards;

  /**
   * The evidence guard. `admin.closing.view` and nothing else: an Auditor holds
   * it, an Approver and an Admin Cabang hold it alongside the run codes, and a
   * Maker holds none of it. Every route registered with this is a SELECT.
   */
  const lihat = [requireSession, requirePermission("admin.closing.view")] as const;

  /**
   * Write guards. `rejectReadOnlyMutation` is belt and braces: the same check
   * already ran globally in core/app.ts, and it stays here so this router is
   * still safe if it is ever mounted somewhere that forgot.
   */
  const ubah = (...izin: string[]) =>
    [requireSession, rejectReadOnlyMutation, requirePermission(...izin)] as const;

  /** The period id in the URL is the subject of every route below. */
  const periodeId = (c: { req: { param: (k: string) => string | undefined } }): string => {
    const cek = new Pemeriksa();
    const id = cek.wajibUuid(c.req.param("id"), "id");
    cek.selesai();
    return id;
  };

  /**
   * The optional branch NARROWING filter, from a body. Never authority: the
   * engine intersects it with the session's scope and refuses a branch outside
   * it, so naming another branch is a 403 on the row's own evidence rather than
   * a wider answer.
   *
   * ABSENT MEANS EVERY BRANCH IN SCOPE, which is spec 8.1's opening line and
   * spec 8.2 step 5's per-branch loop. The key is OMITTED rather than passed as
   * null when nothing was sent, because `JalankanKolektibilitasInput` treats
   * `cabangId: null` as an explicit choice.
   */
  const filterCabang = (b: Record<string, unknown>): { cabangId?: string } => {
    const cek = new Pemeriksa();
    const cabangId = cek.opsionalUuid(b.cabangId, "cabangId");
    cek.selesai();
    return cabangId === null ? {} : { cabangId };
  };

  return new Hono()
    // ------------------------------------------------------------ referensi
    //
    // What both screens load before an operator picks anything: the branches
    // this caller may close for, whether Semua Cabang is among them, and the
    // spec 5.6 policies in force. Every policy is READ from `konfigurasi`, so a
    // client that has switched to CASH_BASIS sees the accrual step described as
    // skipped rather than being told after the click.
    .get("/referensi", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await baca.referensi(konteks(p)));
    })

    // ------------------------------------------------------------- periode
    //
    // The month picker, newest first, each row carrying its status, who closed
    // it, who reopened it and why, and how many frozen balance rows it holds.
    .get("/periode", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const filter = {
        tahun: cek.opsionalTahunTeks(q(c.req.query("tahun")), "tahun"),
        status: cek.opsionalPilihan(
          q(c.req.query("status")),
          "status",
          STATUS_PERIODE,
        ) as StatusPeriode | null,
      };
      cek.selesai();
      return c.json({ data: await baca.daftarPeriode(filter, konteks(p)) });
    })

    .get("/periode/:id", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await baca.periode(periodeId(c), konteks(p)));
    })

    /**
     * SPEC 8.4's TEN PREREQUISITES, ALL TEN, EVERY TIME, IN SPEC ORDER.
     *
     * A GET, and a pure one: the engine writes nothing here, not even a
     * CLOSING_IN_PROGRESS marker, because the screen polls this on every page
     * load and a read with consequences would make refreshing a page a
     * transaction.
     *
     * Gated by `admin.closing.view`, NOT by `admin.closing.periode`: reading the
     * checklist is a separate act from executing the close, and an Approver
     * does the first before deciding whether to do the second. It is also what
     * an Auditor opens (spec 16 scenario 23).
     */
    .get("/periode/:id/prasyarat", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await engine.periksaPrasyarat(periodeId(c), konteks(p)));
    })

    /**
     * The frozen trial balance of a closed period (spec 8.4). Invariant 14's
     * evidence: these are the figures a reprint of a past month must reproduce,
     * and they are read rather than recomputed precisely so a later edit to
     * master data cannot change what was reported.
     *
     * `cabangId` and `akunId` NARROW the answer. The engine refuses a branch
     * outside the caller's scope rather than emptying the result, because an
     * empty trial balance reads as "that branch had no activity", which is a
     * wrong answer presented as a right one.
     */
    .get("/periode/:id/saldo", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const id = periodeId(c);
      const cek = new Pemeriksa();
      const filter = {
        periodeId: id,
        cabangId: cek.opsionalUuid(q(c.req.query("cabangId")), "cabangId"),
        akunId: cek.opsionalUuid(q(c.req.query("akunId")), "akunId"),
      };
      cek.selesai();
      return c.json({ data: await engine.saldoAkunPeriode(filter, konteks(p)) });
    })

    // -------------------------------------------------- 8.1 kolektibilitas
    //
    // spec 9.3 "lihat riwayat": which runs happened for this month, when, by
    // whom and over how many akad. Read-only, so an Auditor can see that the
    // classification ran without being able to run it.
    .get("/periode/:id/kolektibilitas/riwayat", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json({ data: await engine.riwayatKolektibilitas(periodeId(c), konteks(p)) });
    })

    /**
     * The STORED snapshot, which is what the reports read. Distinct from the
     * preview below in the only way that matters: this returns what was
     * committed, and computes nothing.
     */
    .get("/periode/:id/kolektibilitas/snapshot", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const id = periodeId(c);
      const cek = new Pemeriksa();
      const cabangId = cek.opsionalUuid(q(c.req.query("cabangId")), "cabangId");
      cek.selesai();
      return c.json({
        data: await engine.snapshotKolektibilitas(
          cabangId === null ? { periodeId: id } : { periodeId: id, cabangId },
          konteks(p),
        ),
      });
    })

    /**
     * SPEC 8.1's MANDATORY PREVIEW. Runs the whole calculation and returns the
     * migration matrix -- "ringkasan perpindahan kolektibilitas", the feature
     * the spec calls the one accounting users value most -- and WRITES NOTHING:
     * no snapshot, no run row, no mitra flipped to BERMASALAH.
     *
     * A POST despite writing nothing, for the reason `POST /pumk/simulasi` is:
     * it is a computation over the whole portfolio driven by a body, not an
     * addressable resource, and a GET would invite a cache or a bookmark to
     * replay it. It is still not a mutation, and the guard chain agrees: it is
     * gated by `admin.closing.kolektibilitas`, the same code as the commit,
     * because the preview returns every akad's outstanding, arrears and
     * classification for every branch in scope, which is the most sensitive
     * read in the module and is not something to hand out more widely than the
     * run itself.
     *
     * 200, NOT 201: nothing was created. The commit below answers 201. See this
     * file's header for the four ways the two are kept apart.
     */
    .post(
      "/periode/:id/kolektibilitas/pratinjau",
      ...ubah("admin.closing.kolektibilitas"),
      async (c) => {
        const p = requirePrincipal(c);
        const id = periodeId(c);
        const b = await tubuh(c);
        return c.json(
          await engine.previewKolektibilitas({ periodeId: id, ...filterCabang(b) }, konteks(p)),
        );
      },
    )

    /**
     * SPEC 8.1 STEPS 1..7, COMMITTED. Idempotent by design (invariant 13): a
     * re-run for the same scope DELETES that period's snapshots and writes them
     * again inside one transaction, so the snapshot count and the journal count
     * are unchanged by a second run. Refuses with `PERIODE_TIDAK_OPEN` once the
     * period is CLOSED, because a closed month's numbers are frozen.
     *
     * 201: a `closing_kolektibilitas` run row exists afterwards that did not
     * before, even when the re-run replaced an earlier one.
     */
    .post("/periode/:id/kolektibilitas", ...ubah("admin.closing.kolektibilitas"), async (c) => {
      const p = requirePrincipal(c);
      const id = periodeId(c);
      const b = await tubuh(c);
      return c.json(
        await engine.jalankanKolektibilitas({ periodeId: id, ...filterCabang(b) }, konteks(p)),
        201,
      );
    })

    // ------------------------------------------------------ 8.2 penyisihan
    //
    /**
     * Steps 1..3 WITHOUT posting: the accountant sees the movement before it
     * becomes a journal. `id` and `jurnalId` come back null, which is the shape
     * saying no row was written.
     *
     * `admin.closing.periode`, not a code of its own. Spec 9.3 lists TWO
     * closing screens, and the allowance and the accrual are steps inside the
     * second one; inventing `admin.closing.penyisihan` would be this module
     * answering an authorisation question the specification already answered.
     */
    .post("/periode/:id/penyisihan/pratinjau", ...ubah("admin.closing.periode"), async (c) => {
      const p = requirePrincipal(c);
      const id = periodeId(c);
      const b = await tubuh(c);
      return c.json({
        data: await engine.hitungPenyisihan({ periodeId: id, ...filterCabang(b) }, konteks(p)),
      });
    })

    /**
     * Steps 4..5. ONE journal per branch, through `postingEvent`, with an
     * idempotency key derived from (periode, cabang) so a second run cannot
     * double it. Zero movement posts nothing and is NOT an error: the
     * `penyisihan_periode` row is the explicit statement that the movement was
     * nil, which is what prerequisite check 5 reads.
     */
    .post("/periode/:id/penyisihan", ...ubah("admin.closing.periode"), async (c) => {
      const p = requirePrincipal(c);
      const id = periodeId(c);
      const b = await tubuh(c);
      return c.json(
        { data: await engine.jalankanPenyisihan({ periodeId: id, ...filterCabang(b) }, konteks(p)) },
        201,
      );
    })

    // ----------------------------------------------------------- 8.3 akrual
    //
    /**
     * Accrual of jasa administrasi. Reads
     * `akuntansi.metode_pengakuan_jasa_adm`; under CASH_BASIS it writes
     * nothing, posts nothing and answers `dilewati: true` with the method that
     * produced that outcome, so "policy says do nothing" can never be confused
     * with "something went wrong and produced nothing".
     *
     * NO ROUTE HERE CHOOSES THE METHOD. Spec 5's preamble makes it the client
     * accounting team's decision and it lives in `konfigurasi`; a parameter
     * that overrode it per request would let one month be closed on a policy
     * nobody adopted.
     */
    .post("/periode/:id/akrual", ...ubah("admin.closing.periode"), async (c) => {
      const p = requirePrincipal(c);
      const id = periodeId(c);
      const b = await tubuh(c);
      return c.json(
        await engine.jalankanAkrualJasaAdm({ periodeId: id, ...filterCabang(b) }, konteks(p)),
        201,
      );
    })

    // ----------------------------------------------------------- 8.4 tutup
    //
    /**
     * THE CLOSE. Re-runs the whole checklist INSIDE the transaction (a check
     * that passed a minute ago is not evidence), flips the period to CLOSED
     * with `closed_by`/`closed_at`, stamps the report template it was closed
     * under, writes the audit row and FREEZES `saldo_akun_periode` from
     * `v_ledger_baris`.
     *
     * `konfirmasiKasNegatif` is the ONLY field this route accepts, and it is
     * spec 8.4 check 8's "wajib dikonfirmasi user" made explicit: a PERINGATAN
     * left unconfirmed refuses with `KONFIRMASI_KAS_NEGATIF_WAJIB`, so the
     * confirmation is a deliberate act that lands in the audit log rather than
     * a checkbox nobody read. It is NOT an override of any GAGAL check; there
     * is no such flag and there must never be one.
     *
     * NOTHING RETRIES. See this file's header: the engine's row lock is what
     * makes two concurrent closes produce exactly one success, and a retry here
     * would hand the loser a second attempt.
     */
    .post("/periode/:id/tutup", ...ubah("admin.closing.periode"), async (c) => {
      const p = requirePrincipal(c);
      const id = periodeId(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const konfirmasiKasNegatif = cek.opsionalBoolean(
        b.konfirmasiKasNegatif,
        "konfirmasiKasNegatif",
        false,
      );
      cek.selesai();
      return c.json(await engine.tutupPeriode({ periodeId: id, konfirmasiKasNegatif }, konteks(p)));
    })

    /**
     * THE HEAVIEST PRIVILEGE IN THE SYSTEM, and the asymmetry is the control.
     * Closing a period is an operational act; reopening one rewrites a month
     * that has already been reported on and DELETES its frozen balances, which
     * is safe only because those are derived data regenerable from the ledger.
     *
     * Three things gate it, and none of them is optional:
     *   `admin.periode.reopen`, which spec 2 gives to ADMIN_PUSAT and nobody
     *   else -- not even the Approver who is allowed to close;
     *   a written `alasan`, checked here for shape and by the engine for
     *   blankness, recorded in `periode.alasan_reopen` and in the audit log;
     *   `akuntansi.izinkan_reopen_periode`, so a client may switch the whole
     *   capability off.
     * And only the LATEST closed period may be reopened
     * (`REOPEN_BUKAN_PERIODE_TERAKHIR`, with TJSL-PER-002 behind it): reopening
     * an older one would leave a closed month sitting on top of an open one and
     * make every statement since then unreproducible.
     */
    .post("/periode/:id/buka", ...ubah("admin.periode.reopen"), async (c) => {
      const p = requirePrincipal(c);
      const id = periodeId(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const alasan = cek.wajibAlasan(b.alasan, "alasan");
      cek.selesai();
      return c.json(await engine.bukaKembaliPeriode({ periodeId: id, alasan }, konteks(p)));
    })

    // A 404 that is the API's own, in the API's own envelope, rather than
    // Hono's plain-text default: apps/web/src/api/http.ts branches on the JSON
    // body and a bare text 404 would be reported as "the server did not answer"
    // instead of "that path does not exist".
    .all("/*", () => {
      throw notFound("Endpoint closing tidak ditemukan");
    });
}
