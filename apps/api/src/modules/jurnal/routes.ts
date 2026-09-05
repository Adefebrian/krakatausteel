// Hono router for /jurnal (spec 6 made reachable, spec 9.4's seven screens).
//
// WHY IT LANDED LAST, AND WHAT WAS MISSING WITHOUT IT
// The engine has been complete and covered by nine test files since Fase 1; it
// was the DOOR that was missing. `core/app.ts` mounted fifteen routers and none
// of them was this one, so the single most important accounting control in the
// product -- spec 6.3's correction by reversing entry, which spec 9.4 calls
// "Hapus Jurnal Transaksi" precisely because an operator expects a delete and
// must be given a reversal instead -- could not be reached by a person at all.
// Spec 16 scenario 10 could not be run, and the DRAFT that scenario 12 needs
// had to be made by reaching past HTTP into the engine.
//
// IT FOLLOWS modules/closing/routes.ts AND modules/pumk/routes.ts DELIBERATELY.
// Six modules have solved this shape; the parts that are easy to get wrong are
// already solved there. Their five rules are restated here because they are
// what this file is FOR:
//
//   VALIDATE at the boundary. Every handler parses and checks its input BEFORE
//   any engine call and answers `400 VALIDASI` with per-field detail,
//   collecting EVERY bad field into one response. The engine validates again
//   -- it is reachable from a seed, a fixture and five other modules -- so this
//   is the first line, not the only one. Hand written rather than zod, because
//   this repo carries no schema library and six other modules validate this
//   way: adding a dependency is an API-WIDE decision, not one this module gets
//   to make on its own.
//
//   AUTHORISE with `requirePermission`, using CANONICAL codes from modules/auth's
//   catalogue. An unknown code throws at ROUTE-REGISTRATION time, so a typo is a
//   boot failure and never a 403 that reads like policy. All seven codes this
//   file names are SHIPPED, and several were added to the catalogue precisely
//   because the engine gates on them:
//     `jurnal.view`      reads the list and one document. Every operational
//                        role holds it, and it is the ONLY journal code the
//                        read-only Auditor holds (spec 16 scenario 23);
//     `jurnal.create`    files a DRAFT. MAKER;
//     `jurnal.update`    corrects its own DRAFT before anyone verified it;
//     `jurnal.delete`    cancels a DRAFT. Never touches a POSTED entry;
//     `jurnal.verify`    CHECKER, and the engine refuses the journal's own
//                        author (spec 2 rule 1);
//     `jurnal.post`      APPROVER. DRAFT -> POSTED, and the batch;
//     `jurnal.reversal`  APPROVER, and deliberately NOT the same code as
//                        `jurnal.post`: the engine checks this one, so posting
//                        does not silently include the power to reverse.
//
//   NEVER DECIDE BRANCH SCOPE. Not one handler reads a `cabangId` from the
//   request and uses it as authority. `konteks()` carries the branches the
//   SESSION resolved; the engine compares them against the branch the ROW
//   reports, so a manipulated id in the URL selects a row that refuses on its
//   own evidence (spec 2 rule 3, spec 16 scenario 24). The `cabangId` in a
//   create body is the journal's HEADER branch and the engine validates it
//   against the same session scope (validation 6.2.7); on the list route it is
//   a NARROWING filter, intersected with the scope rather than trusted.
//
//   NEVER CATCH A DOMAIN ERROR. `JurnalError` travels to core/http.ts's
//   handler, which maps each code onto its HTTP status, keeps the code in the
//   body as `kodeDomain` and writes the DITOLAK audit row spec 2 rule 5
//   requires. That matters more here than anywhere: this module's refusals ARE
//   the accounting controls. "That period is closed", "this journal is not a
//   DRAFT any more", "you filed it so you cannot verify it", "it has already
//   been reversed" and "debit does not equal credit" are each a specific thing
//   an accountant must act on, and a try/catch here would flatten all of them
//   into one anonymous 500 with no audit row.
//
//   NEVER MUTATE ON GET. Both GETs below are SELECTs through ./baca.ts, which
//   has no write path at all.
//
// FOUR THINGS SPECIFIC TO A LEDGER SURFACE, and each is a NARROWING of the
// engine rather than an addition to it. The engine is reachable from a seed and
// an opening-balance import, which legitimately need the wider surface; a
// person typing into a form does not.
//
//   ONLY THE THREE MANUAL DOCUMENT TYPES CAN BE CREATED HERE. Spec 6.5 names
//   UMUM, KAS_BANK and PINBUK as the manual journals, and spec 9.4 gives each
//   its own screen. `OTOMATIS`, `PENYISIHAN`, `AKRUAL`, `CLOSING` and
//   `SALDO_AWAL` are what an ENGINE stamps on a document it produced, and
//   `REVERSAL` is what a correction pair is made of. Letting an operator type
//   the word `REVERSAL` into a form would let them file a document that claims
//   to be half of a correction without being one: it would carry no
//   `reversal_of_jurnal_id`, offset nothing, and still read as a reversal on
//   every report. `JenisJurnal` keeps all nine because the engine really does
//   produce all nine; this door opens onto three.
//
//   NO `referensiTipe`, NO `referensiId`, AND THEY ARE NOT MERELY IGNORED --
//   SENDING ONE IS A 400. Those columns are what binds a journal to a business
//   document, and `reversalJurnal` reads `referensi_tipe` to decide which
//   `PembalikStateBisnis` must run. A hand-typed journal stamped
//   `pumk_angsuran` would, on reversal, drive a business reverser over a
//   receipt that never happened -- or, for a type with no registered reverser,
//   become permanently unreversible with `PEMBALIK_STATE_BISNIS_TIDAK_TERDAFTAR`.
//   Ignoring the field silently would hide both; refusing it says so.
//
//   NO `kunciIdempotensi` AND NO `isAutoGenerated`, for the same reason.
//   Invariant 13's idempotency key belongs to the closing engine, which derives
//   it from (event, periode, cabang); a caller-chosen key on a manual journal
//   is a way to make a later closing journal collide with a typed one. And a
//   journal a person typed is not auto-generated, so the flag is the engine's
//   to set, never the form's.
//
//   THE REVERSAL ROUTE IS THE DELETE ROUTE, AND THAT IS THE WHOLE POINT. Spec
//   9.4 calls the screen "Hapus Jurnal Transaksi" and ADR 0010 records what
//   actually happens: two rows are added and none is removed, the original
//   stays in the ledger as REVERSED, and `v_ledger_baris` counts both. There is
//   no DELETE method anywhere in this file for a POSTED journal, and there must
//   never be one. `POST /jurnal/:id/batal` exists and refuses anything that is
//   not a DRAFT, which is the engine's rule, not this router's.
import { Hono } from "hono";
import { badRequest, notFound } from "../../core/http";
import { requirePrincipal, type Guards, type Principal } from "../../core/principal";
import {
  POLA_UANG,
  type BarisJurnalInput,
  type BuatJurnalInput,
  type DimensiBaris,
  type JenisJurnal,
  type JurnalContext,
  type JurnalEngine,
  type StatusJurnal,
} from "./contract";
import type { FilterJurnal, JurnalBaca } from "./baca";

export interface JurnalRoutesDeps {
  engine: JurnalEngine;
  baca: JurnalBaca;
  guards: Guards;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * The session's own authority, translated into what the engine takes. Nothing
 * from the request reaches this: `cabangId` is the user's home branch,
 * `cabangDalamScope` is what the session resolved, and `userId` is what
 * `created_by`, `verified_by` and `posted_by` are stamped from. A caller
 * therefore cannot widen their own scope by sending a branch id, and cannot
 * file a journal in someone else's name.
 */
function konteks(principal: Principal): JurnalContext {
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
const POLA_TANGGAL = /^\d{4}-\d{2}-\d{2}$/;

/** Spec 6.5's three manual document types. See this file's header. */
const JENIS_MANUAL = ["UMUM", "KAS_BANK", "PINBUK"] as const;

/** Mirrors the CHECK constraint on `jurnal.status` in migrations/0010. */
const STATUS_JURNAL = ["DRAFT", "POSTED", "REVERSED"] as const;

/** Mirrors the CHECK constraint on `jurnal.jenis`, for the list FILTER only. */
const JENIS_JURNAL = [
  "KAS_BANK",
  "UMUM",
  "PINBUK",
  "OTOMATIS",
  "PENYISIHAN",
  "AKRUAL",
  "REVERSAL",
  "CLOSING",
  "SALDO_AWAL",
] as const;

/**
 * Line ceiling on one document. `jurnal_baris.urutan` is a SMALLINT, so the
 * schema's own ceiling is 32767; this is far lower because a manual journal
 * with a thousand lines is an import, and an import has its own surface
 * (spec 9.6) with its own file limits. Without a ceiling, one POST decides how
 * much memory the process spends.
 */
const MAKS_BARIS = 500;
const MAKS_KETERANGAN = 1000;
/** Batch ceiling for `POST /jurnal/posting-batch`, all-or-nothing by design. */
const MAKS_BATCH = 200;

/**
 * The reversal reason. Checked HERE as well as in the engine, with a minimum
 * length the engine does not impose, for the reason modules/closing gives about
 * a reopen reason: `ALASAN_WAJIB` from the engine means "blank", and a reason
 * of "x" is not blank and is not a reason either. The engine stays the
 * authority on blankness so a batch caller cannot bypass the rule; this adds
 * the shape a form owes its user, and it is the sentence an auditor reads on
 * the reversing journal's `keterangan` months later.
 */
const MIN_ALASAN = 10;
const MAKS_ALASAN = 500;

class Pemeriksa {
  private readonly galat: Record<string, string[]> = {};

  tolak(field: string, pesan: string): void {
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
   * A calendar date, not merely a matching string. `2026-02-30` matches the
   * pattern and is not a day; letting it through would produce a period lookup
   * that finds nothing and a refusal blaming the period instead of the typo.
   */
  wajibTanggal(nilai: unknown, field: string): string {
    if (typeof nilai !== "string" || !POLA_TANGGAL.test(nilai)) {
      this.tolak(field, "wajib tanggal YYYY-MM-DD");
      return "";
    }
    const d = new Date(`${nilai}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== nilai) {
      this.tolak(field, "wajib tanggal YYYY-MM-DD");
      return "";
    }
    return nilai;
  }

  opsionalTanggal(nilai: string | null, field: string): string | null {
    if (nilai === null) return null;
    return this.wajibTanggal(nilai, field) || null;
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
    if (typeof nilai !== "string" || !(pilihan as readonly string[]).includes(nilai)) {
      this.tolak(field, `wajib salah satu dari: ${pilihan.join(", ")}`);
      return null;
    }
    return nilai as T;
  }

  /**
   * Strictly boolean, never "any truthy value", for the reason
   * modules/closing's `konfirmasiKasNegatif` is: a filter that read `"mungkin"`
   * as true would silently answer a different question than the one asked.
   */
  opsionalBoolean(nilai: unknown, field: string): boolean | null {
    if (nilai === undefined || nilai === null || nilai === "") return null;
    if (nilai === true || nilai === "true") return true;
    if (nilai === false || nilai === "false") return false;
    this.tolak(field, "wajib true atau false");
    return null;
  }

  opsionalTeks(nilai: unknown, field: string, maks: number): string | null {
    if (nilai === undefined || nilai === null || nilai === "") return null;
    if (typeof nilai !== "string") {
      this.tolak(field, "wajib teks");
      return null;
    }
    if (nilai.length > maks) {
      this.tolak(field, `maksimal ${maks} karakter`);
      return null;
    }
    return nilai;
  }

  /**
   * A decimal string with exactly two fractional digits, which is what `Uang`
   * is (see ./contract.ts's header on why money is never a `number` here). A
   * JSON number arriving in this field is REFUSED rather than stringified: an
   * IEEE-754 double is exactly the representation this system exists to keep
   * out of the ledger, and `String(0.1 + 0.2)` would enter it looking valid.
   */
  opsionalUang(nilai: unknown, field: string): string | undefined {
    if (nilai === undefined || nilai === null || nilai === "") return undefined;
    if (typeof nilai === "number") {
      this.tolak(field, "wajib teks desimal dua angka di belakang koma, bukan angka JSON");
      return undefined;
    }
    if (typeof nilai !== "string" || !POLA_UANG.test(nilai)) {
      this.tolak(field, "wajib desimal dua angka di belakang koma, misalnya 1500000.00");
      return undefined;
    }
    return nilai;
  }

  wajibAlasan(nilai: unknown, field: string): string {
    if (typeof nilai !== "string") {
      this.tolak(field, `wajib teks alasan, ${MIN_ALASAN} sampai ${MAKS_ALASAN} karakter`);
      return "";
    }
    const bersih = nilai.trim();
    if (bersih.length < MIN_ALASAN || bersih.length > MAKS_ALASAN) {
      this.tolak(field, `wajib teks alasan, ${MIN_ALASAN} sampai ${MAKS_ALASAN} karakter`);
      return "";
    }
    return bersih;
  }

  /**
   * Analytic dimensions. A plain object of scalars, one level deep: the column
   * is `jsonb` and the engine writes it verbatim, so an unbounded nested
   * structure here is an unbounded row there.
   */
  opsionalDimensi(nilai: unknown, field: string): DimensiBaris | undefined {
    if (nilai === undefined || nilai === null) return undefined;
    if (typeof nilai !== "object" || Array.isArray(nilai)) {
      this.tolak(field, "wajib objek dimensi");
      return undefined;
    }
    const isi = nilai as Record<string, unknown>;
    const kunci = Object.keys(isi);
    if (kunci.length > 20) {
      this.tolak(field, "maksimal 20 dimensi per baris");
      return undefined;
    }
    for (const k of kunci) {
      const v = isi[k];
      if (v === null || v === undefined) continue;
      if (typeof v === "object") {
        this.tolak(`${field}.${k}`, "wajib nilai sederhana, bukan objek atau array");
        continue;
      }
      if (typeof v === "string" && v.length > 200) {
        this.tolak(`${field}.${k}`, "maksimal 200 karakter");
      }
    }
    return isi as DimensiBaris;
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
 * Fields the engine accepts and this door does not. Refused rather than
 * dropped: see the header. Naming them one by one, instead of rejecting every
 * unknown key, keeps a future additive field from becoming a breaking change
 * for a client that sends it early.
 */
const FIELD_TERLARANG: Array<[string, string]> = [
  ["referensiTipe", "tautan ke dokumen bisnis tidak boleh diisi dari jurnal manual"],
  ["referensiId", "tautan ke dokumen bisnis tidak boleh diisi dari jurnal manual"],
  ["kunciIdempotensi", "kunci idempotensi hanya dipakai engine closing"],
  ["isAutoGenerated", "jurnal yang diketik operator bukan jurnal otomatis"],
];

/**
 * The create/edit body, validated once and shared by both routes because
 * `ubahJurnalDraft` takes the identical input shape (it replaces the whole
 * draft, header and lines, which is what an edit of a document with a running
 * total has to be).
 *
 * `jenis` is validated here but IGNORED by the edit route: the engine keeps the
 * stored `jenis` across an edit, because `no_jurnal` is allocated per (jenis,
 * periode) and a type change would leave the number lying about the document.
 */
function bacaBodyJurnal(b: Record<string, unknown>): BuatJurnalInput {
  const cek = new Pemeriksa();
  for (const [field, alasan] of FIELD_TERLARANG) {
    if (b[field] !== undefined) cek.tolak(field, alasan);
  }

  const cabangId = cek.wajibUuid(b.cabangId, "cabangId");
  const jenis = cek.wajibPilihan(b.jenis, "jenis", JENIS_MANUAL) as JenisJurnal;
  const tanggalTransaksi = cek.wajibTanggal(b.tanggalTransaksi, "tanggalTransaksi");
  const keterangan = cek.opsionalTeks(b.keterangan, "keterangan", MAKS_KETERANGAN);

  const mentah = b.baris;
  const baris: BarisJurnalInput[] = [];
  if (!Array.isArray(mentah)) {
    cek.tolak("baris", "wajib array baris jurnal");
  } else if (mentah.length > MAKS_BARIS) {
    cek.tolak("baris", `maksimal ${MAKS_BARIS} baris per jurnal`);
  } else {
    mentah.forEach((isi, i) => {
      if (typeof isi !== "object" || isi === null || Array.isArray(isi)) {
        cek.tolak(`baris.${i}`, "wajib objek baris jurnal");
        return;
      }
      const r = isi as Record<string, unknown>;
      const akunId = cek.wajibUuid(r.akunId, `baris.${i}.akunId`);
      const debit = cek.opsionalUang(r.debit, `baris.${i}.debit`);
      const kredit = cek.opsionalUang(r.kredit, `baris.${i}.kredit`);
      const mitraId = cek.opsionalUuid(r.mitraId, `baris.${i}.mitraId`);
      const akadId = cek.opsionalUuid(r.akadId, `baris.${i}.akadId`);
      const ket = cek.opsionalTeks(r.keterangan, `baris.${i}.keterangan`, MAKS_KETERANGAN);
      const dimensi = cek.opsionalDimensi(r.dimensi, `baris.${i}.dimensi`);
      baris.push({
        akunId,
        ...(debit !== undefined ? { debit } : {}),
        ...(kredit !== undefined ? { kredit } : {}),
        keterangan: ket,
        mitraId,
        akadId,
        ...(dimensi !== undefined ? { dimensi } : {}),
      });
    });
  }
  cek.selesai();

  // WHAT IS DELIBERATELY NOT CHECKED HERE: "exactly one of debit/kredit"
  // (6.2.3), "at least two lines" (6.2.2), "debit equals credit" (6.2.5), and
  // whether the account is postable (6.2.6). Those are the ACCOUNTING rules and
  // they belong to the engine, which states each of them once, refuses with its
  // own code and is reached from five other callers. Re-deriving them here
  // would put a second, drifting opinion about what a journal is in front of
  // the one that matters. What this function owns is SHAPE: what cannot be
  // parsed, what is not money, and what this door refuses to accept at all.
  return { cabangId, jenis, tanggalTransaksi, keterangan, baris };
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export function createJurnalRoutes({ engine, baca, guards }: JurnalRoutesDeps) {
  const { requireSession, requirePermission, rejectReadOnlyMutation } = guards;

  /** The read guard. `jurnal.view` and nothing else; every route on it is a SELECT. */
  const lihat = [requireSession, requirePermission("jurnal.view")] as const;

  /**
   * Write guards. `rejectReadOnlyMutation` is belt and braces: the same check
   * already ran globally in core/app.ts, and it stays here so this router is
   * still safe if it is ever mounted somewhere that forgot.
   */
  const ubah = (...izin: string[]) =>
    [requireSession, rejectReadOnlyMutation, requirePermission(...izin)] as const;

  /** The journal id in the URL is the subject of every by-id route below. */
  const jurnalId = (c: { req: { param: (k: string) => string | undefined } }): string => {
    const cek = new Pemeriksa();
    const id = cek.wajibUuid(c.req.param("id"), "id");
    cek.selesai();
    return id;
  };

  return new Hono()
    // --------------------------------------------------------------- daftar
    //
    // spec 9.4 "Daftar Jurnal": every document with its status, from DRAFT
    // through POSTED to REVERSED. The same route serves the Checker's
    // verification queue (`?status=DRAFT`) and the Approver's reversal picker
    // (`?status=POSTED`), because those are the same list under a filter and
    // two endpoints returning the same rows would eventually disagree.
    .get("/", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const filter: FilterJurnal = {
        periodeId: cek.opsionalUuid(q(c.req.query("periodeId")), "periodeId"),
        cabangId: cek.opsionalUuid(q(c.req.query("cabangId")), "cabangId"),
        jenis: cek.opsionalPilihan(
          q(c.req.query("jenis")),
          "jenis",
          JENIS_JURNAL,
        ) as JenisJurnal | null,
        status: cek.opsionalPilihan(
          q(c.req.query("status")),
          "status",
          STATUS_JURNAL,
        ) as StatusJurnal | null,
        cari: cek.opsionalTeks(q(c.req.query("cari")), "cari", 200),
        dariTanggal: cek.opsionalTanggal(q(c.req.query("dariTanggal")), "dariTanggal"),
        sampaiTanggal: cek.opsionalTanggal(q(c.req.query("sampaiTanggal")), "sampaiTanggal"),
        otomatis: cek.opsionalBoolean(q(c.req.query("otomatis")), "otomatis"),
      };
      cek.selesai();
      return c.json({ data: await baca.daftar(filter, konteks(p)) });
    })

    /**
     * One document with its lines, the accounts named, and both ends of its
     * correction pair resolved to document numbers.
     *
     * A journal in another branch answers 404, not 403, and that is deliberate:
     * see the branch-scope note at the top of ./baca.ts. The id in the URL
     * selects the row; the row states its own branch.
     */
    .get("/:id", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await baca.detail(jurnalId(c), konteks(p)));
    })

    // ------------------------------------------------------ 6.2, 9.4 input
    /**
     * ALWAYS BORN DRAFT, and there is no flag on this route that could post it
     * in the same call. Spec 6.3's whole maker/checker/approver split lives in
     * the fact that filing and posting are separate acts by separate people,
     * and a `?post=true` would be one typo away from collapsing it.
     *
     * 201: a document exists afterwards that did not before, with a `no_jurnal`
     * allocated atomically per (jenis, periode) by validation 6.2.9.
     */
    .post("/", ...ubah("jurnal.create"), async (c) => {
      const p = requirePrincipal(c);
      const input = bacaBodyJurnal(await tubuh(c));
      return c.json(await engine.buatJurnal(input, konteks(p)), 201);
    })

    /**
     * Spec 6.3: "Jurnal DRAFT boleh diedit. Setiap edit menaikkan `version`."
     *
     * A PUT and not a PATCH, because the engine replaces the whole document:
     * every line is deleted and rewritten, so a partial update would be this
     * router merging a document the engine never merges. A POSTED journal
     * refuses with `JURNAL_TIDAK_DRAFT` and comes back with every column,
     * `version` included, untouched (spec 6.6.5).
     */
    .put("/:id", ...ubah("jurnal.update"), async (c) => {
      const p = requirePrincipal(c);
      const id = jurnalId(c);
      const input = bacaBodyJurnal(await tubuh(c));
      return c.json(await engine.ubahJurnalDraft(id, input, konteks(p)));
    })

    /**
     * A DRAFT is cancelled, never deleted: `deleted_at` plus `deleted_by`, so
     * the attempt stays in the database and in the audit log. Anything that is
     * not a DRAFT refuses with `JURNAL_TIDAK_DRAFT`; a POSTED journal is
     * corrected by the reversal route below and by nothing else.
     *
     * Answers a body rather than 204 so the SPA's one JSON envelope holds for
     * every response (apps/web/src/api/http.ts branches on the body).
     */
    .post("/:id/batal", ...ubah("jurnal.delete"), async (c) => {
      const p = requirePrincipal(c);
      const id = jurnalId(c);
      await engine.batalkanJurnalDraft(id, konteks(p));
      return c.json({ id, dibatalkan: true });
    })

    /**
     * spec 9.4 "Verifikasi Jurnal Draft". The engine refuses the journal's own
     * `created_by` with `MAKER_TIDAK_BOLEH_CHECKER`, which core/http.ts maps to
     * 409 SEGREGASI_TUGAS: spec 2 rule 1 is "the system must refuse, not merely
     * hide the button", and this is where that is true over HTTP.
     */
    .post("/:id/verifikasi", ...ubah("jurnal.verify"), async (c) => {
      const p = requirePrincipal(c);
      return c.json(await engine.verifikasiJurnal(jurnalId(c), konteks(p)));
    })

    /**
     * DRAFT -> POSTED, the moment the entry enters the ledger. The engine takes
     * a row lock, so two concurrent requests produce exactly one POSTED journal
     * and the loser refuses with `POSTING_BENTROK` (spec 6.6.9).
     *
     * NOTHING HERE RETRIES, on a 409 or on anything else. A retry would hand
     * the loser of that race a second attempt against a journal the winner has
     * already posted.
     */
    .post("/:id/posting", ...ubah("jurnal.post"), async (c) => {
      const p = requirePrincipal(c);
      return c.json(await engine.postingJurnal(jurnalId(c), konteks(p)));
    })

    /**
     * spec 6.6.8 and spec 9.4's "posting batch": ATOMIC, all or nothing. One
     * invalid member leaves NOTHING posted and refuses with `BATCH_GAGAL`,
     * whose `detail` names the offending journal and the code that stopped it.
     *
     * A separate path from `/:id/posting` rather than a list-shaped body on it,
     * so a client cannot accidentally send one and get the other's semantics.
     */
    .post("/posting-batch", ...ubah("jurnal.post"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const mentah = b.ids;
      const ids: string[] = [];
      if (!Array.isArray(mentah)) {
        cek.tolak("ids", "wajib array id jurnal");
      } else if (mentah.length === 0) {
        cek.tolak("ids", "wajib berisi minimal satu id jurnal");
      } else if (mentah.length > MAKS_BATCH) {
        cek.tolak("ids", `maksimal ${MAKS_BATCH} jurnal per batch`);
      } else {
        mentah.forEach((v, i) => ids.push(cek.wajibUuid(v, `ids.${i}`)));
      }
      cek.selesai();
      return c.json({ data: await engine.postingBatch(ids, konteks(p)) });
    })

    /**
     * SPEC 9.4's "HAPUS JURNAL TRANSAKSI", AND SPEC 16 SCENARIO 10.
     *
     * The screen is called delete and this is a CREATE: the answer is the
     * REVERSING journal, `jenis = REVERSAL`, debit and credit swapped line for
     * line, dated in the CURRENT OPEN period because the original's period may
     * already be closed, with the original's `no_jurnal` quoted in its
     * `keterangan`. The original is marked REVERSED and STAYS IN THE LEDGER
     * (ADR 0010): `v_ledger_baris` counts POSTED and REVERSED, so the pair nets
     * to zero and neither half is ever counted alone.
     *
     * 201, because a new document exists afterwards. Answering 200 would read
     * as "the delete succeeded", which is exactly the misunderstanding this
     * whole design exists to prevent.
     *
     * `alasan` is mandatory and lands verbatim in the reversing journal's
     * `keterangan` and in the audit log. A journal that is already REVERSED
     * refuses with `JURNAL_SUDAH_REVERSED` (spec 6.6.7) and a DRAFT with
     * `JURNAL_BELUM_POSTED` -- a draft is cancelled, not reversed.
     */
    .post("/:id/pembalik", ...ubah("jurnal.reversal"), async (c) => {
      const p = requirePrincipal(c);
      const id = jurnalId(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const alasan = cek.wajibAlasan(b.alasan, "alasan");
      cek.selesai();
      return c.json(await engine.reversalJurnal(id, alasan, konteks(p)), 201);
    })

    // A 404 that is the API's own, in the API's own envelope, rather than
    // Hono's plain-text default: apps/web/src/api/http.ts branches on the JSON
    // body and a bare text 404 would be reported as "the server did not answer"
    // instead of "that path does not exist".
    .all("/*", () => {
      throw notFound("Endpoint jurnal tidak ditemukan");
    });
}
