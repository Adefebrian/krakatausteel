// Hono router for /nonpumk (spec 9.2). The HTTP surface of the grant line:
// the proposal state machine, the penilaian, the checker review and the
// approval that may CUT the amount, the STAGED disbursement, the LPJ with its
// verification and rejection, and the late-LPJ monitoring dashboard with the
// 30/60/90 ageing buckets.
//
// IT FOLLOWS modules/pumk/routes.ts DELIBERATELY, line for line where the
// problem is the same. That file landed first, it is the same problem, and the
// parts that are easy to get wrong are already solved there. The five rules it
// states are restated here because they are what this file is FOR:
//
//   VALIDATE at the boundary. Every handler parses and checks its body BEFORE
//   any service call, and answers `400 VALIDASI` with per-field detail,
//   collecting EVERY bad field into one response so a form is not submitted
//   five times to learn five problems. The engine validates again -- it is
//   reachable from a seed and from later phases -- so this is the first line,
//   not the only one. Hand written rather than zod, because this repo carries
//   no schema library and modules/konfigurasi and modules/pumk both validate
//   this way: adding a dependency is an API-WIDE decision, not one this module
//   gets to make on its own.
//
//   AUTHORISE with `requirePermission`, using CANONICAL codes from
//   modules/auth's catalogue. An unknown code throws at ROUTE-REGISTRATION
//   time (`resolveRequiredPermissions`), so a typo is a boot failure and never
//   a 403 that reads like policy. `nonpumk.lpj.verifikasi` was missing from
//   that catalogue when the engine was written and the engine failed closed
//   with IZIN_BELUM_TERDAFTAR; it has since been added and granted to the
//   Checker, which is why the two LPJ decision routes can name it here.
//
//   NEVER DECIDE BRANCH SCOPE. Not one handler reads a `cabangId` from the
//   request and uses it as authority. `konteks()` carries the branches the
//   SESSION resolved; the service compares them against the branch the ROW
//   reports, so a manipulated id in the URL selects a row that refuses on its
//   own evidence (spec 2 rule 3, spec 16 scenario 24). The ONE place a branch
//   arrives in a payload is `POST /nonpumk/proposal`, where no row exists yet
//   to read it from, and the engine checks it against the caller's scope
//   before it writes anything.
//
//   NEVER CATCH A DOMAIN ERROR. `NonPumkError` and `JurnalError` travel to
//   core/http.ts's handler, which maps each code onto its HTTP status, keeps
//   the code in the body as `kodeDomain` and writes the DITOLAK audit row spec
//   2 rule 5 requires. A try/catch here would turn a precise refusal into an
//   anonymous 500 with no audit trail.
//
//   NEVER MUTATE ON GET. Read-only roles are refused every non-GET by the
//   global guard in core/app.ts before any of this runs; that guarantee is
//   worth nothing if a GET writes.
//
// NOTHING HERE MOVES MONEY. `POST /nonpumk/proposal/:id/penyaluran` RECORDS a
// disbursement made at a counter or through a bank and posts the journal that
// recognises it; `.../lpj/verifikasi` records that the remainder came back.
// There is no payment instruction and no transfer anywhere in this module.
//
// TWO PLACES WHERE THE MONEY IS, and what this file does about them:
//
//   THE TERMIN THAT LANDS EXACTLY ON THE APPROVED AMOUNT MUST SUCCEED, and one
//   that exceeds it by a single sen must be refused BEFORE the ledger is
//   called. This file makes that possible by doing nothing clever: it hands
//   the amount to the engine as the two-decimal string it arrived as, and the
//   engine compares in SEN, ahead of the DEFERRED TJSL-NPK-002 which would
//   otherwise surface at COMMIT as a plpgsql string with no way back. Parsing
//   the amount into a float here would break that by itself.
//
//   THE LPJ RETURN JOURNAL CREDITS THE ACCOUNT THE DISBURSEMENT DEBITED, per
//   bidang. `POST /nonpumk/proposal/:id/lpj/verifikasi` therefore takes a CASH
//   account and NOTHING ELSE: the expense account comes from the termin row
//   through the engine's own lookup. Accepting an `akunBebanId` on this route
//   would let the form credit a different account from the one that was
//   debited, and both journals would still balance while the bidang's expense
//   stayed overstated forever.
import { Hono } from "hono";
import { badRequest, notFound } from "../../core/http";
import { requirePrincipal, type Guards, type Principal } from "../../core/principal";
import type {
  EmberUmurLpj,
  KeputusanApproverNonPumk,
  KeputusanCheckerNonPumk,
  NonPumkContext,
  NonPumkEngine,
  SdgInput,
} from "./contract";
import type { NonPumkBaca } from "./baca";

export interface NonPumkRoutesDeps {
  engine: NonPumkEngine;
  baca: NonPumkBaca;
  guards: Guards;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * The session's own authority, translated into what the engine takes. Nothing
 * from the request body reaches this: `cabangId` is the user's home branch and
 * `cabangDalamScope` is what the session resolved, so a caller cannot widen
 * their own scope by sending a branch id.
 */
function konteks(principal: Principal): NonPumkContext {
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

const POLA_UANG = /^\d{1,18}\.\d{2}$/;
/** `bobot` is NUMERIC(9,6): up to three digits before the point, up to six after. */
const POLA_BOBOT = /^\d{1,3}(?:\.\d{1,6})?$/;
/** `skor_total` is NUMERIC(9,6) too, and arrives as plain decimal text. */
const POLA_SKOR = /^\d{1,3}(?:\.\d{1,6})?$/;
const POLA_TANGGAL = /^\d{4}-\d{2}-\d{2}$/;
const POLA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_TEKS = 2000;
/** Spec 9.2 asks for at least one SDG. Seventeen exist, so more is a mistake. */
const MAX_SDG = 17;

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

  wajibUang(nilai: unknown, field: string): string {
    if (typeof nilai !== "string" || !POLA_UANG.test(nilai)) {
      this.tolak(field, "wajib desimal dua angka di belakang koma, misalnya 1500000.00");
      return "0.00";
    }
    return nilai;
  }

  /**
   * A plain decimal, as TEXT. Never `Number()`: the assessment score is
   * compared against a configured pass mark in fixed precision, and a score
   * that made a round trip through a float can fail a comparison the operator
   * watched succeed on their own screen.
   */
  wajibDesimal(nilai: unknown, field: string): string {
    if (typeof nilai !== "string" || !POLA_SKOR.test(nilai)) {
      this.tolak(field, "wajib desimal tanpa tanda, misalnya 82.500000");
      return "0";
    }
    return nilai;
  }

  wajibTanggal(nilai: unknown, field: string): string {
    if (typeof nilai !== "string" || !POLA_TANGGAL.test(nilai)) {
      this.tolak(field, "wajib tanggal dengan format YYYY-MM-DD");
      return "";
    }
    return nilai;
  }

  opsionalTanggal(nilai: unknown, field: string): string | null {
    if (nilai === undefined || nilai === null || nilai === "") return null;
    return this.wajibTanggal(nilai, field);
  }

  /** Spec 9.2's beneficiary count: mandatory, whole, and allowed to be zero. */
  wajibCacah(nilai: unknown, field: string, maks = 10_000_000): number {
    if (typeof nilai !== "number" || !Number.isInteger(nilai) || nilai < 0 || nilai > maks) {
      this.tolak(field, `wajib bilangan bulat antara 0 dan ${maks}`);
      return 0;
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

  opsionalBoolean(nilai: unknown, field: string): boolean {
    if (nilai === undefined || nilai === null || nilai === "") return false;
    if (nilai === true || nilai === "true") return true;
    if (nilai === false || nilai === "false") return false;
    this.tolak(field, "wajib true atau false");
    return false;
  }

  opsionalObjek(nilai: unknown, field: string): Record<string, unknown> {
    if (nilai === undefined || nilai === null) return {};
    if (typeof nilai !== "object" || Array.isArray(nilai)) {
      this.tolak(field, "wajib berupa objek");
      return {};
    }
    return nilai as Record<string, unknown>;
  }

  daftarTeks(nilai: unknown, field: string, maksItem = 20): string[] {
    if (nilai === undefined || nilai === null) return [];
    if (!Array.isArray(nilai) || nilai.length > maksItem) {
      this.tolak(field, `wajib daftar teks, maksimal ${maksItem} item`);
      return [];
    }
    const keluar: string[] = [];
    for (const item of nilai) {
      if (typeof item !== "string" || item.length > 512) {
        this.tolak(field, "setiap item wajib teks maksimal 512 karakter");
        return [];
      }
      keluar.push(item);
    }
    return keluar;
  }

  /**
   * Spec 9.2's mandatory mapping: at least one SDG, each with an optional
   * weight in (0, 1].
   *
   * The SHAPE is checked here and the SET is checked by the engine
   * (`SDG_WAJIB`, `SDG_DUPLIKAT`, `SDG_TIDAK_DITEMUKAN`,
   * `BOBOT_SDG_TIDAK_VALID`), because whether a goal EXISTS is a database
   * question and whether "0.5" is a number is not. An empty array is refused
   * in both places on purpose: the form deserves a field-level message and the
   * engine must still refuse a direct call.
   */
  daftarSdg(nilai: unknown, field: string): SdgInput[] {
    if (!Array.isArray(nilai) || nilai.length === 0 || nilai.length > MAX_SDG) {
      this.tolak(field, `wajib minimal satu SDG, maksimal ${MAX_SDG}`);
      return [];
    }
    const keluar: SdgInput[] = [];
    for (const [i, item] of nilai.entries()) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        this.tolak(`${field}[${i}]`, "wajib objek { sdgId, bobot }");
        continue;
      }
      const baris = item as Record<string, unknown>;
      const sdgId = this.wajibUuid(baris.sdgId, `${field}[${i}].sdgId`);
      let bobot: string | null = null;
      if (baris.bobot !== undefined && baris.bobot !== null && baris.bobot !== "") {
        if (typeof baris.bobot !== "string" || !POLA_BOBOT.test(baris.bobot)) {
          this.tolak(`${field}[${i}].bobot`, "wajib desimal, misalnya 0.500000");
        } else {
          bobot = baris.bobot;
        }
      }
      keluar.push({ sdgId, bobot });
    }
    return keluar;
  }

  selesai(): void {
    const kunci = Object.keys(this.galat);
    if (kunci.length > 0) {
      throw badRequest("Data yang dikirim belum valid", this.galat);
    }
  }
}

/** The body, as an object. A non-object body is an empty one, not a crash. */
async function tubuh(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
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
// migrations/0009_nonpumk.sql or a union in ./contract.ts, so a value this
// file lets through is one the database would also accept.
// ---------------------------------------------------------------------------

const STATUS_PROPOSAL = [
  "DRAFT",
  "PENILAIAN",
  "REVIEW_CHECKER",
  "MENUNGGU_PERSETUJUAN",
  "DISETUJUI",
  "DISALURKAN",
  "MENUNGGU_LPJ",
  "LPJ_DIAJUKAN",
  "SELESAI",
  "TIDAK_DIREKOMENDASIKAN",
  "DITOLAK",
  "LPJ_DITOLAK",
] as const;
const SUMBER_PENGAJUAN = ["INTERNAL", "PORTAL_ONLINE"] as const;
const KEPUTUSAN_CHECKER = ["REKOMENDASI", "TIDAK_REKOMENDASI", "MINTA_PERBAIKAN"] as const;
const KEPUTUSAN_APPROVER = ["SETUJU", "TOLAK", "KEMBALIKAN"] as const;
const EMBER = ["UMUR_0_29", "UMUR_30_59", "UMUR_60_89", "UMUR_90_PLUS"] as const;

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export function createNonPumkRoutes({ engine, baca, guards }: NonPumkRoutesDeps) {
  const { requireSession, requirePermission, rejectReadOnlyMutation } = guards;

  /** Read guards: a session, plus `nonpumk.view`, which every role holds. */
  const lihat = [requireSession, requirePermission("nonpumk.view")] as const;

  /**
   * Write guards. `rejectReadOnlyMutation` is belt and braces: the same check
   * already ran globally in core/app.ts, and it stays here so this router is
   * still safe if it is ever mounted somewhere that forgot.
   */
  const ubah = (...izin: string[]) =>
    [requireSession, rejectReadOnlyMutation, requirePermission(...izin)] as const;

  return new Hono()
    // ----------------------------------------------------------- referensi
    //
    // What the proposal form has to load before it can be filled in: the
    // bounds it validates against, the bidang it must map to, the SDG it must
    // pick at least one of, and the expense accounts the disbursement form
    // chooses from. All four answer from configuration and master data, never
    // from a literal in this repo.
    .get("/batasan", ...lihat, async (c) => {
      return c.json(await baca.batasan(konteks(requirePrincipal(c))));
    })

    .get("/bidang", ...lihat, async (c) => {
      return c.json({ data: await baca.daftarBidang(konteks(requirePrincipal(c))) });
    })

    .get("/sdg", ...lihat, async (c) => {
      return c.json({ data: await baca.daftarSdg(konteks(requirePrincipal(c))) });
    })

    .get("/akun-beban", ...lihat, async (c) => {
      return c.json({ data: await baca.daftarAkunBeban(konteks(requirePrincipal(c))) });
    })

    // -------------------------------------------------------------- proposal
    //
    // Spec 9.2's list: bidang, SDG, status and date filters. `cabangId` is
    // accepted as a FILTER and is not authority: the service intersects it
    // with the branches the session resolved, so naming another branch narrows
    // the answer or is ignored, and never widens it.
    .get("/proposal", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const filter = {
        cabangId: cek.opsionalUuid(q(c.req.query("cabangId")), "cabangId"),
        bidangId: cek.opsionalUuid(q(c.req.query("bidangId")), "bidangId"),
        sdgId: cek.opsionalUuid(q(c.req.query("sdgId")), "sdgId"),
        status: cek.opsionalPilihan(q(c.req.query("status")), "status", STATUS_PROPOSAL),
        sumberPengajuan: cek.opsionalPilihan(
          q(c.req.query("sumberPengajuan")),
          "sumberPengajuan",
          SUMBER_PENGAJUAN,
        ),
        dariTanggal: cek.opsionalTanggal(q(c.req.query("dariTanggal")), "dariTanggal"),
        sampaiTanggal: cek.opsionalTanggal(q(c.req.query("sampaiTanggal")), "sampaiTanggal"),
        cari: q(c.req.query("cari")),
      };
      cek.selesai();
      return c.json({ data: await baca.daftarProposal(filter, konteks(p)) });
    })

    .post("/proposal", ...ubah("nonpumk.create"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const input = {
        // The branch is validated as a SHAPE only; whether this caller may act
        // in it is the SERVICE's decision. This is the one payload in the
        // module that names a branch, because there is no row yet to read it
        // from.
        cabangId: cek.wajibUuid(b.cabangId, "cabangId"),
        tanggalProposal: cek.wajibTanggal(b.tanggalProposal, "tanggalProposal"),
        tanggalDaftar: cek.opsionalTanggal(b.tanggalDaftar, "tanggalDaftar"),
        namaPemohon: cek.wajibTeks(b.namaPemohon, "namaPemohon", 200),
        atasNama: cek.opsionalTeks(b.atasNama, "atasNama", 200),
        alamat: cek.opsionalTeks(b.alamat, "alamat", 500),
        kelurahan: cek.opsionalTeks(b.kelurahan, "kelurahan", 120),
        kecamatan: cek.opsionalTeks(b.kecamatan, "kecamatan", 120),
        kotaId: cek.opsionalUuid(b.kotaId, "kotaId"),
        telepon: cek.opsionalTeks(b.telepon, "telepon", 40),
        email: cek.opsionalTeks(b.email, "email", 200),
        // Spec 9.2: bidang is MANDATORY and at least one SDG is MANDATORY.
        // Both are refused here as a missing FIELD and again by the engine as
        // a missing ROW, which are different failures and deserve different
        // messages.
        bidangId: cek.wajibUuid(b.bidangId, "bidangId"),
        sdg: cek.daftarSdg(b.sdg, "sdg"),
        judulProgram: cek.wajibTeks(b.judulProgram, "judulProgram", 300),
        deskripsiProgram: cek.opsionalTeks(b.deskripsiProgram, "deskripsiProgram"),
        jumlahDiajukan: cek.wajibUang(b.jumlahDiajukan, "jumlahDiajukan"),
        penerimaManfaatEstimasi: cek.wajibCacah(
          b.penerimaManfaatEstimasi,
          "penerimaManfaatEstimasi",
        ),
      };
      cek.selesai();
      return c.json(await engine.buatProposal(input, konteks(p)), 201);
    })

    .get("/proposal/:id", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const id = cek.wajibUuid(c.req.param("id"), "id");
      cek.selesai();
      return c.json(await baca.detailProposal(id, konteks(p)));
    })

    .get("/proposal/:id/timeline", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const id = cek.wajibUuid(c.req.param("id"), "id");
      cek.selesai();
      return c.json({ data: await engine.timeline(id, konteks(p)) });
    })

    .post("/proposal/:id/ajukan-penilaian", ...ubah("nonpumk.create"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const id = cek.wajibUuid(c.req.param("id"), "id");
      const catatan = cek.opsionalTeks(b.catatan, "catatan");
      cek.selesai();
      return c.json(await engine.ajukanPenilaian(id, catatan, konteks(p)));
    })

    // Spec 9.2's penilaian and its score. `skorTotal` is a STRING all the way
    // through: it is compared against a configured pass mark in fixed
    // precision, and a float that arrived as 69.99999999 would fail a check
    // the operator can see passing on their screen.
    .post("/proposal/:id/penilaian", ...ubah("nonpumk.penilaian"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      // The id in the URL is authoritative over any id in the body, so a body
      // that names a different proposal cannot act on it.
      const proposalId = cek.wajibUuid(c.req.param("id"), "id");
      const input = {
        proposalId,
        tanggal: cek.wajibTanggal(b.tanggal, "tanggal"),
        petugasKaryawanId: cek.opsionalUuid(b.petugasKaryawanId, "petugasKaryawanId"),
        // Spec 4.5: kelayakan, urgensi, dampak, kesesuaian bidang, kesesuaian
        // SDG. Free-form because the client has not fixed the rubric; stored
        // as jsonb and never interpreted here.
        hasil: cek.opsionalObjek(b.hasil, "hasil"),
        skorTotal: cek.wajibDesimal(b.skorTotal, "skorTotal"),
        nilaiRekomendasi: cek.wajibUang(b.nilaiRekomendasi, "nilaiRekomendasi"),
        catatan: cek.opsionalTeks(b.catatan, "catatan"),
        lampiran: cek.daftarTeks(b.lampiran, "lampiran"),
      };
      cek.selesai();
      return c.json(await engine.inputPenilaian(input, konteks(p)));
    })

    // The checker's review. TIDAK_REKOMENDASI and MINTA_PERBAIKAN carry a
    // MANDATORY note; that is the state machine's rule (`catatanWajib`) and it
    // is enforced there rather than duplicated here, so the two cannot drift.
    .post("/proposal/:id/review", ...ubah("nonpumk.review"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const proposalId = cek.wajibUuid(c.req.param("id"), "id");
      const input = {
        proposalId,
        tanggal: cek.wajibTanggal(b.tanggal, "tanggal"),
        keputusan: cek.wajibPilihan(
          b.keputusan,
          "keputusan",
          KEPUTUSAN_CHECKER,
        ) as KeputusanCheckerNonPumk,
        catatan: cek.opsionalTeks(b.catatan, "catatan"),
      };
      cek.selesai();
      return c.json(await engine.review(input, konteks(p)));
    })

    // The approval. `jumlahDisetujui` may be LOWER than what was asked for and
    // never higher: the cut is spec 9.2's, and the engine refuses a raise with
    // NILAI_DISETUJUI_MELEBIHI_PENGAJUAN. This file does not compare the two,
    // because the amount asked for lives on the ROW and a comparison against a
    // number from the same request would prove nothing.
    .post("/proposal/:id/persetujuan", ...ubah("nonpumk.approve"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const proposalId = cek.wajibUuid(c.req.param("id"), "id");
      const input = {
        proposalId,
        tanggal: cek.wajibTanggal(b.tanggal, "tanggal"),
        keputusan: cek.wajibPilihan(
          b.keputusan,
          "keputusan",
          KEPUTUSAN_APPROVER,
        ) as KeputusanApproverNonPumk,
        jumlahDisetujui:
          b.jumlahDisetujui === undefined ||
          b.jumlahDisetujui === null ||
          b.jumlahDisetujui === ""
            ? null
            : cek.wajibUang(b.jumlahDisetujui, "jumlahDisetujui"),
        catatan: cek.opsionalTeks(b.catatan, "catatan"),
      };
      cek.selesai();
      return c.json(await engine.putuskanPersetujuan(input, konteks(p)));
    })

    // ------------------------------------------------------------ penyaluran
    //
    // RECORDS one termin of a staged disbursement that happened at a counter
    // or through a bank, and posts the PENYALURAN_NON_PUMK journal that
    // recognises it. It instructs no payment.
    //
    // `akunBebanId` is on the form because spec 6.4 makes the expense account
    // PER BIDANG and the shipped mapping row carries `debit_dari_payload`.
    // This file passes it through and names no account of its own; the engine
    // refuses anything that is not a postable, active, non-cash BEBAN account
    // of this entity before the ledger is called.
    .post("/proposal/:id/penyaluran", ...ubah("nonpumk.penyaluran"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const proposalId = cek.wajibUuid(c.req.param("id"), "id");
      const input = {
        proposalId,
        tanggalPenyaluran: cek.wajibTanggal(b.tanggalPenyaluran, "tanggalPenyaluran"),
        // Handed to the engine as the STRING it arrived as. The ceiling check
        // is done in sen against the approved amount, before any posting.
        jumlah: cek.wajibUang(b.jumlah, "jumlah"),
        akunKasId: cek.wajibUuid(b.akunKasId, "akunKasId"),
        akunBebanId: cek.wajibUuid(b.akunBebanId, "akunBebanId"),
        noBukti: cek.opsionalTeks(b.noBukti, "noBukti", 64),
        keterangan: cek.opsionalTeks(b.keterangan, "keterangan"),
      };
      cek.selesai();
      return c.json(await engine.catatPenyaluran(input, konteks(p)), 201);
    })

    // "No further termin": closes the staging and STARTS the LPJ clock, which
    // is what the ageing of spec 9.2 is measured from. A separate act rather
    // than an inference, because a grant that is fully disbursed in two termin
    // and one that is deliberately stopped short are the same row otherwise.
    .post("/proposal/:id/tutup-penyaluran", ...ubah("nonpumk.penyaluran"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const id = cek.wajibUuid(c.req.param("id"), "id");
      const catatan = cek.opsionalTeks(b.catatan, "catatan");
      cek.selesai();
      return c.json(await engine.tutupPenyaluran(id, catatan, konteks(p)));
    })

    // ------------------------------------------------------------------- LPJ
    //
    // Filing. POSTS NO JOURNAL: the money comes back when the LPJ is ACCEPTED,
    // not when it is filed. `jumlahSisaDikembalikan` is NOT accepted here and
    // must not be: the engine computes it as disbursed minus realised, so the
    // two figures cannot disagree and the deferred TJSL-NPK-003 has nothing
    // left to catch.
    .post("/proposal/:id/lpj", ...ubah("nonpumk.lpj"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const proposalId = cek.wajibUuid(c.req.param("id"), "id");
      const input = {
        proposalId,
        tanggalLpj: cek.wajibTanggal(b.tanggalLpj, "tanggalLpj"),
        jumlahRealisasi: cek.wajibUang(b.jumlahRealisasi, "jumlahRealisasi"),
        penerimaManfaatAktual: cek.wajibCacah(
          b.penerimaManfaatAktual,
          "penerimaManfaatAktual",
        ),
        uraianRealisasi: cek.opsionalTeks(b.uraianRealisasi, "uraianRealisasi"),
        lampiran: cek.daftarTeks(b.lampiran, "lampiran"),
      };
      cek.selesai();
      return c.json(await engine.ajukanLpj(input, konteks(p)), 201);
    })

    // Acceptance. `nonpumk.lpj.verifikasi` is the Checker's code and is
    // deliberately NOT `nonpumk.lpj` (the Maker files it), NOT `nonpumk.review`
    // (that is the review of the PROPOSAL) and NOT `nonpumk.approve` (that was
    // the decision to release the money, months earlier).
    //
    // `akunKasId` and NOTHING ELSE. Where the returned money landed is a fact
    // about a bank statement; WHICH EXPENSE ACCOUNT IS CREDITED BACK is not a
    // choice at all, it is the account that termin debited, and the engine
    // reads it from the termin row.
    .post("/proposal/:id/lpj/verifikasi", ...ubah("nonpumk.lpj.verifikasi"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const proposalId = cek.wajibUuid(c.req.param("id"), "id");
      const input = {
        proposalId,
        tanggalVerifikasi: cek.wajibTanggal(b.tanggalVerifikasi, "tanggalVerifikasi"),
        // Optional at the boundary and REQUIRED by the engine whenever there
        // is a remainder, because only the engine knows whether there is one.
        akunKasId: cek.opsionalUuid(b.akunKasId, "akunKasId"),
        catatan: cek.opsionalTeks(b.catatan, "catatan"),
      };
      cek.selesai();
      return c.json(await engine.verifikasiLpj(input, konteks(p)));
    })

    // Rejection, with a note that is the entire content of the refusal: without
    // it the recipient has nothing to correct. Mandatory in the state machine
    // (`catatanWajib`) and mandatory here, so the form says which field is
    // missing instead of answering CATATAN_WAJIB with no field name.
    .post("/proposal/:id/lpj/tolak", ...ubah("nonpumk.lpj.verifikasi"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const proposalId = cek.wajibUuid(c.req.param("id"), "id");
      const input = {
        proposalId,
        tanggal: cek.wajibTanggal(b.tanggal, "tanggal"),
        catatan: cek.wajibTeks(b.catatan, "catatan"),
      };
      cek.selesai();
      return c.json(await engine.tolakLpj(input, konteks(p)));
    })

    // ------------------------------------------------------ monitoring LPJ
    //
    // Spec 9.2: "Dashboard monitoring LPJ yang terlambat, dengan aging (30, 60,
    // 90 hari sejak penyaluran)". The buckets are the spec's; `terlambat` is a
    // configured deadline the engine reads. Oldest first, because that is what
    // has to be handled first.
    .get("/monitoring-lpj", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const filter = {
        cabangId: cek.opsionalUuid(q(c.req.query("cabangId")), "cabangId"),
        bidangId: cek.opsionalUuid(q(c.req.query("bidangId")), "bidangId"),
        emberMinimal: cek.opsionalPilihan(
          q(c.req.query("emberMinimal")),
          "emberMinimal",
          EMBER,
        ) as EmberUmurLpj | null,
        hanyaTerlambat: cek.opsionalBoolean(q(c.req.query("hanyaTerlambat")), "hanyaTerlambat"),
      };
      cek.selesai();
      return c.json({ data: await baca.monitoringLpj(filter, konteks(p)) });
    })

    // A 404 that is the API's own, in the API's own envelope, rather than
    // Hono's plain-text default: apps/web/src/api/http.ts branches on the JSON
    // body and a bare text 404 would be reported as "the server did not
    // answer" instead of "that path does not exist".
    .all("/*", () => {
      throw notFound("Endpoint Non PUMK tidak ditemukan");
    });
}
