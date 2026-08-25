// Hono router for /pumk (spec 9.1). The HTTP surface of the Pendanaan UMK
// module: the proposal state machine, the akad, the schedule, the
// disbursement, the instalment receipts, the restructuring, the termination,
// the collection trail, the cluster roster and the read models the 17 screens
// in apps/web/src/pages/pumk/ read.
//
// THE PATHS ARE NOT INVENTED HERE. apps/web/src/api/pumk.ts was written first
// and names every endpoint; this file matches it rather than defining a second
// vocabulary that would force the SPA to be rewritten. Where that client names
// something the engine did not yet answer (`/pumk/batasan`,
// `/pumk/reschedule/pratinjau`, `/pumk/pengakhiran/pratinjau`), the answer is
// built in ./baca.ts, from configuration and from the collaborating engines,
// never from a number typed into this repo.
//
// WHAT THIS FILE IS ALLOWED TO DO, and what it must not:
//
//   VALIDATE at the boundary. Every handler parses and checks its body BEFORE
//   any service call, and answers `400 VALIDASI` with per-field detail. The
//   engine validates again -- it is reachable from the seed and from later
//   phases -- so this is the first line, not the only one.
//
//   AUTHORISE with `requirePermission`, using CANONICAL codes from
//   modules/auth's catalogue. An unknown code throws at route-registration
//   time (see `resolveRequiredPermissions`), so a typo is a boot failure, not
//   a 403 that looks like policy. The engine checks the same permission again
//   from the context, which is what makes a direct service call safe too.
//
//   NEVER DECIDE BRANCH SCOPE. Not one handler reads a `cabangId` from the
//   request and uses it as authority. The context carries the branches the
//   SESSION allows, the service compares them against the branch the ROW
//   reports, and a manipulated id in the URL therefore selects a row that
//   refuses on its own evidence (spec 2 rule 3, spec 16 scenario 24).
//
//   NEVER CATCH A DOMAIN ERROR. `PumkError`, `AngsuranError` and `JurnalError`
//   travel to core/http.ts's handler, which maps each code onto its HTTP
//   status and keeps the code in the body. A try/catch here would turn a
//   precise refusal into an anonymous 500.
//
//   NEVER MUTATE ON GET. Read-only roles are refused every non-GET by the
//   global guard in core/app.ts before any of this runs; that guarantee is
//   worth nothing if a GET writes.
//
// NOTHING HERE MOVES MONEY. Every write records something that already
// happened at a counter or a bank, and posts the journal that recognises it.
// There is no payment instruction, no transfer, no disbursement to a rail:
// `POST /pumk/pencairan` records a disbursement made outside the system, and
// `POST /pumk/angsuran` records cash already received.
import { Hono } from "hono";
import { badRequest, notFound } from "../../core/http";
import { requirePrincipal, type Guards, type Principal } from "../../core/principal";
import type { JenisPengakhiran, PumkContext, PumkEngine } from "./contract";
import type { PumkBaca } from "./baca";

/** Object storage, as the SUBSET this module uses. Satisfied by ObjectStorePort. */
export interface PorterPenyimpananPumk {
  putObject(key: string, body: Uint8Array): Promise<void>;
}

export interface PumkRoutesDeps {
  engine: PumkEngine;
  baca: PumkBaca;
  penyimpanan: PorterPenyimpananPumk;
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
function konteks(principal: Principal): PumkContext {
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
//
// Hand written rather than zod, because this repo carries no schema library
// and modules/konfigurasi/routes.ts already validates this way; adding a
// dependency for one module is a decision for the whole API, not for this
// file. The shapes are the same either way: one `400 VALIDASI` carrying EVERY
// bad field, so a form does not have to be submitted five times to learn five
// problems.

const POLA_UANG = /^\d{1,18}\.\d{2}$/;
const POLA_RATE = /^\d{1,3}\.\d{6}$/;
const POLA_TANGGAL = /^\d{4}-\d{2}-\d{2}$/;
const POLA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_TEKS = 2000;

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

  wajibRate(nilai: unknown, field: string): string {
    if (typeof nilai !== "string" || !POLA_RATE.test(nilai)) {
      this.tolak(field, "wajib desimal enam angka di belakang koma, misalnya 0.030000");
      return "0.000000";
    }
    return nilai;
  }

  opsionalRate(nilai: unknown, field: string): string | null {
    if (nilai === undefined || nilai === null || nilai === "") return null;
    if (typeof nilai !== "string" || !POLA_RATE.test(nilai)) {
      this.tolak(field, "wajib desimal enam angka di belakang koma, misalnya 0.030000");
      return null;
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

  wajibBulat(nilai: unknown, field: string, min: number, max: number): number {
    if (typeof nilai !== "number" || !Number.isInteger(nilai) || nilai < min || nilai > max) {
      this.tolak(field, `wajib bilangan bulat antara ${min} dan ${max}`);
      return min;
    }
    return nilai;
  }

  opsionalBulat(nilai: unknown, field: string, min: number, max: number): number | null {
    if (nilai === undefined || nilai === null) return null;
    return this.wajibBulat(nilai, field, min, max);
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
// migrations/0008_pumk.sql, so a value this file lets through is one the
// database would also accept, and a value it refuses never reaches Postgres.
// ---------------------------------------------------------------------------

const JENIS_JAMINAN = ["BPKB", "SHM", "SHGB", "AJB", "DEPOSITO", "TANPA_JAMINAN", "LAINNYA"] as const;
const KEPUTUSAN_CHECKER = ["REKOMENDASI", "TIDAK_REKOMENDASI", "MINTA_PERBAIKAN"] as const;
const KEPUTUSAN_APPROVER = ["SETUJU", "TOLAK", "KEMBALIKAN"] as const;
const METODE = ["FLAT", "EFEKTIF", "ANUITAS"] as const;
const JENIS_RESCHEDULE = [
  "PERPANJANG_TENOR",
  "TURUNKAN_ANGSURAN",
  "GRACE_PERIOD",
  "RESTRUKTUR_POKOK",
] as const;
const JENIS_PENGAKHIRAN = ["LUNAS_DIPERCEPAT", "HAPUS_BUKU", "PENGHAPUSAN_BERSYARAT"] as const;
const JENIS_TINDAK_LANJUT = ["KUNJUNGAN", "TELEPON", "SURAT_PERINGATAN", "SOMASI"] as const;
const STATUS_PROPOSAL = [
  "DRAFT",
  "SURVEY_PENDING",
  "SURVEY_SELESAI",
  "REVIEW_CHECKER",
  "MENUNGGU_PERSETUJUAN",
  "DISETUJUI",
  "AKAD_DIBUAT",
  "JADWAL_SIAP",
  "DICAIRKAN",
  "TIDAK_DIREKOMENDASIKAN",
  "DITOLAK",
] as const;
const SUMBER_PENGAJUAN = ["INTERNAL", "PORTAL_ONLINE"] as const;
const STATUS_AKAD = ["BELUM_CAIR", "AKTIF", "LUNAS", "RESCHEDULED", "MACET", "HAPUS_BUKU"] as const;
const STATUS_RESCHEDULE = ["DRAFT", "DISETUJUI", "DITOLAK"] as const;

/** Attachment types the upload endpoint accepts, and the ceiling it enforces. */
const MIME_LAMPIRAN = new Map<string, string>([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["application/pdf", "pdf"],
]);
/**
 * Deliberately the SAME ceiling as core/hardening.ts's `MAX_BODY_BYTES`.
 * Raising it is a hardening decision for the whole API (the server refuses a
 * larger body before any route sees it), never a decision this file makes on
 * its own.
 */
const MAX_LAMPIRAN_BYTES = 1_000_000;
const KONTEKS_LAMPIRAN = /^[a-z0-9][a-z0-9-]{0,40}$/;

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export function createPumkRoutes({ engine, baca, penyimpanan, guards }: PumkRoutesDeps) {
  const { requireSession, requirePermission, rejectReadOnlyMutation } = guards;

  /** Read guards: a session, plus `pumk.view`, which every role in spec 2 holds. */
  const lihat = [requireSession, requirePermission("pumk.view")] as const;

  /**
   * Write guards. `rejectReadOnlyMutation` is belt and braces: the same check
   * already ran globally in core/app.ts, and it stays here so this router is
   * still safe if it is ever mounted somewhere that forgot.
   */
  const ubah = (...izin: string[]) =>
    [requireSession, rejectReadOnlyMutation, requirePermission(...izin)] as const;

  return new Hono()
    // ----------------------------------------------------------- konfigurasi
    .get("/batasan", ...lihat, async (c) => {
      return c.json(await baca.batasan(konteks(requirePrincipal(c))));
    })

    // -------------------------------------------------------------- proposal
    .get("/proposal", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const status = q(c.req.query("status"));
      const sumber = q(c.req.query("sumberPengajuan"));
      const cek = new Pemeriksa();
      const filter = {
        cabangId: cek.opsionalUuid(q(c.req.query("cabangId")), "cabangId"),
        sektorId: cek.opsionalUuid(q(c.req.query("sektorId")), "sektorId"),
        status: cek.opsionalPilihan(status, "status", STATUS_PROPOSAL),
        sumberPengajuan: cek.opsionalPilihan(sumber, "sumberPengajuan", SUMBER_PENGAJUAN),
        dariTanggal: cek.opsionalTanggal(q(c.req.query("dariTanggal")), "dariTanggal"),
        sampaiTanggal: cek.opsionalTanggal(q(c.req.query("sampaiTanggal")), "sampaiTanggal"),
        cari: q(c.req.query("cari")),
      };
      cek.selesai();
      return c.json({ data: await baca.daftarProposal(filter, konteks(p)) });
    })

    .post("/proposal", ...ubah("pumk.create"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const input = {
        // The branch is validated as a shape only; whether this caller may act
        // in it is the SERVICE's decision, against the branch the mitra and the
        // session report.
        cabangId: cek.wajibUuid(b.cabangId, "cabangId"),
        mitraId: cek.wajibUuid(b.mitraId, "mitraId"),
        sektorId: cek.opsionalUuid(b.sektorId, "sektorId"),
        tanggalProposal: cek.wajibTanggal(b.tanggalProposal, "tanggalProposal"),
        tanggalDaftar: cek.opsionalTanggal(b.tanggalDaftar, "tanggalDaftar"),
        jumlahDiajukan: cek.wajibUang(b.jumlahDiajukan, "jumlahDiajukan"),
        tenorDiajukan: cek.wajibBulat(b.tenorDiajukan, "tenorDiajukan", 1, 600),
        tujuanPenggunaan: cek.opsionalTeks(b.tujuanPenggunaan, "tujuanPenggunaan"),
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
      return c.json({ data: await baca.timeline(id, konteks(p)) });
    })

    .get("/proposal/:id/jaminan", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const id = cek.wajibUuid(c.req.param("id"), "id");
      cek.selesai();
      return c.json({ data: await baca.daftarJaminan(id, konteks(p)) });
    })

    .post("/proposal/:id/jaminan", ...ubah("pumk.create"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const id = cek.wajibUuid(c.req.param("id"), "id");
      const input = {
        jenis: cek.wajibPilihan(b.jenis, "jenis", JENIS_JAMINAN),
        deskripsi: cek.opsionalTeks(b.deskripsi, "deskripsi"),
        nilaiTaksasi:
          b.nilaiTaksasi === undefined || b.nilaiTaksasi === null || b.nilaiTaksasi === ""
            ? null
            : cek.wajibUang(b.nilaiTaksasi, "nilaiTaksasi"),
        nomorDokumen: cek.opsionalTeks(b.nomorDokumen, "nomorDokumen", 200),
        atasNama: cek.opsionalTeks(b.atasNama, "atasNama", 200),
        lokasi: cek.opsionalTeks(b.lokasi, "lokasi", 500),
        tanggalTerima: cek.opsionalTanggal(b.tanggalTerima, "tanggalTerima"),
      };
      cek.selesai();
      return c.json(await engine.tambahJaminan(id, input, konteks(p)), 201);
    })

    .post("/proposal/:id/submit-survey", ...ubah("pumk.create"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const id = cek.wajibUuid(c.req.param("id"), "id");
      const catatan = cek.opsionalTeks(b.catatan, "catatan");
      cek.selesai();
      return c.json(await engine.submitUntukSurvey(id, catatan, konteks(p)));
    })

    .post("/proposal/:id/ajukan-checker", ...ubah("pumk.create"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const id = cek.wajibUuid(c.req.param("id"), "id");
      const catatan = cek.opsionalTeks(b.catatan, "catatan");
      cek.selesai();
      return c.json(await engine.ajukanKeChecker(id, catatan, konteks(p)));
    })

    .post("/proposal/:id/review", ...ubah("pumk.review"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      // The id in the URL is authoritative over the one in the body, so a body
      // that names a different proposal cannot act on it.
      const proposalId = cek.wajibUuid(c.req.param("id"), "id");
      const input = {
        proposalId,
        tanggal: cek.wajibTanggal(b.tanggal, "tanggal"),
        keputusan: cek.wajibPilihan(b.keputusan, "keputusan", KEPUTUSAN_CHECKER),
        catatan: cek.opsionalTeks(b.catatan, "catatan"),
      };
      cek.selesai();
      return c.json(await engine.review(input, konteks(p)));
    })

    .post("/proposal/:id/persetujuan", ...ubah("pumk.approve"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const proposalId = cek.wajibUuid(c.req.param("id"), "id");
      const input = {
        proposalId,
        tanggal: cek.wajibTanggal(b.tanggal, "tanggal"),
        keputusan: cek.wajibPilihan(b.keputusan, "keputusan", KEPUTUSAN_APPROVER),
        // Spec 9.1: the approver may CUT the plafon and the tenor, and the akad
        // must be built from these, not from what was proposed (scenario 3).
        plafonDisetujui:
          b.plafonDisetujui === undefined || b.plafonDisetujui === null || b.plafonDisetujui === ""
            ? null
            : cek.wajibUang(b.plafonDisetujui, "plafonDisetujui"),
        tenorDisetujui: cek.opsionalBulat(b.tenorDisetujui, "tenorDisetujui", 1, 600),
        jasaAdmRate: cek.opsionalRate(b.jasaAdmRate, "jasaAdmRate"),
        catatan: cek.opsionalTeks(b.catatan, "catatan"),
      };
      cek.selesai();
      return c.json(await engine.putuskanPersetujuan(input, konteks(p)));
    })

    // ---------------------------------------------------------------- survey
    .post("/survey", ...ubah("pumk.survey"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const input = {
        proposalId: cek.wajibUuid(b.proposalId, "proposalId"),
        tanggalSurvey: cek.wajibTanggal(b.tanggalSurvey, "tanggalSurvey"),
        petugasKaryawanId: cek.opsionalUuid(b.petugasKaryawanId, "petugasKaryawanId"),
        hasil: cek.opsionalObjek(b.hasil, "hasil"),
        skorTotal: cek.wajibTeks(b.skorTotal, "skorTotal", 32),
        plafonRekomendasi: cek.wajibUang(b.plafonRekomendasi, "plafonRekomendasi"),
        tenorRekomendasi: cek.wajibBulat(b.tenorRekomendasi, "tenorRekomendasi", 1, 600),
        catatan: cek.opsionalTeks(b.catatan, "catatan"),
        lampiranFoto: cek.daftarTeks(b.lampiranFoto, "lampiranFoto"),
      };
      cek.selesai();
      return c.json(await engine.inputSurvey(input, konteks(p)));
    })

    // ---------------------------------------------------------------- portal
    .post("/portal/konversi", ...ubah("portal.konversi"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const input = {
        submissionId: cek.wajibUuid(b.submissionId, "submissionId"),
        cabangId: cek.wajibUuid(b.cabangId, "cabangId"),
        mitraId: cek.wajibUuid(b.mitraId, "mitraId"),
        sektorId: cek.opsionalUuid(b.sektorId, "sektorId"),
        tanggalProposal: cek.wajibTanggal(b.tanggalProposal, "tanggalProposal"),
        catatanPetugas: cek.opsionalTeks(b.catatanPetugas, "catatanPetugas"),
      };
      cek.selesai();
      return c.json(await engine.konversiSubmissionPortal(input, konteks(p)), 201);
    })

    // ------------------------------------------------------------------ akad
    .get("/akad", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const filter = {
        cabangId: cek.opsionalUuid(q(c.req.query("cabangId")), "cabangId"),
        status: cek.opsionalPilihan(q(c.req.query("status")), "status", STATUS_AKAD),
        kolektibilitas: q(c.req.query("kolektibilitas"), 32),
        cari: q(c.req.query("cari")),
      };
      cek.selesai();
      return c.json({ data: await baca.daftarAkad(filter, konteks(p)) });
    })

    .post("/akad", ...ubah("pumk.akad"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const input = {
        proposalId: cek.wajibUuid(b.proposalId, "proposalId"),
        tanggalAkad: cek.wajibTanggal(b.tanggalAkad, "tanggalAkad"),
        tanggalMulaiAngsuran: cek.wajibTanggal(b.tanggalMulaiAngsuran, "tanggalMulaiAngsuran"),
        gracePeriodBulan: cek.opsionalBulat(b.gracePeriodBulan, "gracePeriodBulan", 0, 120) ?? 0,
        metodePerhitungan: cek.opsionalPilihan(b.metodePerhitungan, "metodePerhitungan", METODE),
        pathDokumenAkad: cek.opsionalTeks(b.pathDokumenAkad, "pathDokumenAkad", 512),
      };
      cek.selesai();
      return c.json(
        await engine.buatAkad(
          {
            proposalId: input.proposalId,
            tanggalAkad: input.tanggalAkad,
            tanggalMulaiAngsuran: input.tanggalMulaiAngsuran,
            gracePeriodBulan: input.gracePeriodBulan,
            ...(input.metodePerhitungan ? { metodePerhitungan: input.metodePerhitungan } : {}),
            pathDokumenAkad: input.pathDokumenAkad,
          },
          konteks(p),
        ),
        201,
      );
    })

    .get("/akad/:id", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const id = cek.wajibUuid(c.req.param("id"), "id");
      cek.selesai();
      return c.json(await baca.detailAkad(id, konteks(p)));
    })

    .get("/akad/:id/jadwal", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const id = cek.wajibUuid(c.req.param("id"), "id");
      cek.selesai();
      const versi = await baca.riwayatJadwal(id, konteks(p));
      // Newest first: the page shows every version and marks the live one.
      return c.json({ data: [...versi].sort((a, z) => z.versi - a.versi) });
    })

    .post("/akad/:id/jadwal", ...ubah("pumk.akad"), async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const id = cek.wajibUuid(c.req.param("id"), "id");
      cek.selesai();
      return c.json(await engine.generateJadwal(id, konteks(p)), 201);
    })

    .get("/akad/:id/tindak-lanjut", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const id = cek.wajibUuid(c.req.param("id"), "id");
      cek.selesai();
      return c.json({ data: await engine.daftarTindakLanjut(id, konteks(p)) });
    })

    .post("/akad/:id/tindak-lanjut", ...ubah("pumk.penagihan"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const akadId = cek.wajibUuid(c.req.param("id"), "id");
      const input = {
        akadId,
        tanggal: cek.wajibTanggal(b.tanggal, "tanggal"),
        jenis: cek.wajibPilihan(b.jenis, "jenis", JENIS_TINDAK_LANJUT),
        hasil: cek.opsionalTeks(b.hasil, "hasil"),
        petugasKaryawanId: cek.opsionalUuid(b.petugasKaryawanId, "petugasKaryawanId"),
        catatan: cek.opsionalTeks(b.catatan, "catatan"),
        lampiran: cek.daftarTeks(b.lampiran, "lampiran"),
      };
      cek.selesai();
      return c.json(await engine.catatTindakLanjut(input, konteks(p)), 201);
    })

    // -------------------------------------------------------------- pencairan
    //
    // RECORDS a disbursement that happened at the counter or through the bank.
    // It instructs no payment; what it adds is the receivable and the journal
    // that recognises it.
    .post("/pencairan", ...ubah("pumk.pencairan"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const input = {
        akadId: cek.wajibUuid(b.akadId, "akadId"),
        tanggalPencairan: cek.wajibTanggal(b.tanggalPencairan, "tanggalPencairan"),
        jumlah: cek.wajibUang(b.jumlah, "jumlah"),
        akunKasId: cek.wajibUuid(b.akunKasId, "akunKasId"),
        noBukti: cek.opsionalTeks(b.noBukti, "noBukti", 64),
        keterangan: cek.opsionalTeks(b.keterangan, "keterangan"),
      };
      cek.selesai();
      return c.json(await engine.catatPencairan(input, konteks(p)), 201);
    })

    // --------------------------------------------------------------- angsuran
    //
    // RECORDS cash already received, and lets the instalment engine allocate
    // it. An overpayment lands in Kelebihan Pembayaran; this route neither
    // decides that nor computes it.
    .post("/angsuran", ...ubah("pumk.angsuran"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const input = {
        akadId: cek.wajibUuid(b.akadId, "akadId"),
        tanggalTerima: cek.wajibTanggal(b.tanggalTerima, "tanggalTerima"),
        jumlah: cek.wajibUang(b.jumlah, "jumlah"),
        akunKasId: cek.wajibUuid(b.akunKasId, "akunKasId"),
        noBukti: cek.opsionalTeks(b.noBukti, "noBukti", 64),
        tanggalValuta: cek.opsionalTanggal(b.tanggalValuta, "tanggalValuta"),
        keterangan: cek.opsionalTeks(b.keterangan, "keterangan"),
      };
      cek.selesai();
      return c.json(await engine.terimaAngsuran(input, konteks(p)), 201);
    })

    // --------------------------------------------------------------- simulasi
    //
    // Spec 7.4's calculator. Stores nothing, posts nothing. A POST because the
    // parameter set is a body, not because anything changes.
    .post("/simulasi", requireSession, rejectReadOnlyMutation, requirePermission("pumk.view"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const input = {
        pokok: cek.wajibUang(b.pokok, "pokok"),
        rate: cek.wajibRate(b.rate, "rate"),
        metode: cek.wajibPilihan(b.metode, "metode", METODE),
        tenorBulan: cek.wajibBulat(b.tenorBulan, "tenorBulan", 1, 600),
        gracePeriodBulan: cek.opsionalBulat(b.gracePeriodBulan, "gracePeriodBulan", 0, 120) ?? 0,
        tanggalMulaiAngsuran: cek.wajibTanggal(b.tanggalMulaiAngsuran, "tanggalMulaiAngsuran"),
      };
      cek.selesai();
      return c.json(await baca.simulasiJadwal(input, konteks(p)));
    })

    // ------------------------------------------------------------- reschedule
    .get("/reschedule", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const filter = {
        akadId: cek.opsionalUuid(q(c.req.query("akadId")), "akadId"),
        status: cek.opsionalPilihan(q(c.req.query("status")), "status", STATUS_RESCHEDULE),
      };
      cek.selesai();
      return c.json({ data: await baca.daftarReschedule(filter, konteks(p)) });
    })

    // The preview spec 9.1 requires BEFORE submit. It writes no version, posts
    // no journal, and runs the SAME engine that would build the real one.
    .post("/reschedule/pratinjau", ...ubah("pumk.reschedule"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const input = {
        akadId: cek.wajibUuid(b.akadId, "akadId"),
        jenis: cek.wajibPilihan(b.jenis, "jenis", JENIS_RESCHEDULE),
        tenorBaru: cek.opsionalBulat(b.tenorBaru, "tenorBaru", 1, 600),
        graceBaru: cek.opsionalBulat(b.graceBaru, "graceBaru", 0, 120),
        jasaRateBaru: cek.opsionalRate(b.jasaRateBaru, "jasaRateBaru"),
      };
      cek.selesai();
      return c.json(await baca.pratinjauReschedule(input, konteks(p)));
    })

    .post("/reschedule", ...ubah("pumk.reschedule"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const input = {
        akadId: cek.wajibUuid(b.akadId, "akadId"),
        tanggalPengajuan: cek.wajibTanggal(b.tanggalPengajuan, "tanggalPengajuan"),
        alasan: cek.wajibTeks(b.alasan, "alasan"),
        jenis: cek.wajibPilihan(b.jenis, "jenis", JENIS_RESCHEDULE),
        tenorBaru: cek.opsionalBulat(b.tenorBaru, "tenorBaru", 1, 600),
        graceBaru: cek.opsionalBulat(b.graceBaru, "graceBaru", 0, 120),
        jasaRateBaru: cek.opsionalRate(b.jasaRateBaru, "jasaRateBaru"),
        catatan: cek.opsionalTeks(b.catatan, "catatan"),
      };
      cek.selesai();
      return c.json(await engine.ajukanReschedule(input, konteks(p)), 201);
    })

    .post("/reschedule/:id/setujui", ...ubah("pumk.approve"), async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const id = cek.wajibUuid(c.req.param("id"), "id");
      cek.selesai();
      return c.json(await engine.setujuiReschedule(id, konteks(p)));
    })

    // ------------------------------------------------------------ pengakhiran
    .get("/pengakhiran", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const cabangId = cek.opsionalUuid(q(c.req.query("cabangId")), "cabangId");
      cek.selesai();
      return c.json({ data: await baca.daftarPengakhiran({ cabangId }, konteks(p)) });
    })

    // The write-off preview: outstanding, allowance available, allowance
    // consumed and the shortfall AS SEPARATE FIGURES. A write-off presented as
    // one number tells the operator nothing about what will hit the ledger.
    //
    // Either permission opens it because either termination is previewable
    // here: LUNAS_DIPERCEPAT belongs to the approver, HAPUS_BUKU to the
    // write-off holder, and the ENGINE picks the exact one per `jenis` when the
    // decision is actually recorded.
    .post("/pengakhiran/pratinjau", ...ubah("pumk.hapusbuku", "pumk.approve"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const input = {
        akadId: cek.wajibUuid(b.akadId, "akadId"),
        jenis: cek.wajibPilihan(b.jenis, "jenis", JENIS_PENGAKHIRAN) as JenisPengakhiran,
        tanggal: cek.wajibTanggal(b.tanggal, "tanggal"),
      };
      cek.selesai();
      return c.json(await baca.pratinjauPengakhiran(input, konteks(p)));
    })

    .post("/pengakhiran", ...ubah("pumk.hapusbuku", "pumk.approve"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const input = {
        akadId: cek.wajibUuid(b.akadId, "akadId"),
        jenis: cek.wajibPilihan(b.jenis, "jenis", JENIS_PENGAKHIRAN) as JenisPengakhiran,
        tanggal: cek.wajibTanggal(b.tanggal, "tanggal"),
        dasarKeputusan: cek.wajibTeks(b.dasarKeputusan, "dasarKeputusan"),
        noSk: cek.opsionalTeks(b.noSk, "noSk", 64),
        akunKasId: cek.opsionalUuid(b.akunKasId, "akunKasId"),
      };
      cek.selesai();
      return c.json(await engine.catatPengakhiran(input, konteks(p)), 201);
    })

    // --------------------------------------------------------------- cluster
    .get("/cluster", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const filter = {
        cabangId: cek.opsionalUuid(q(c.req.query("cabangId")), "cabangId"),
        cari: q(c.req.query("cari")),
      };
      cek.selesai();
      return c.json({ data: await baca.daftarCluster(filter, konteks(p)) });
    })

    .get("/cluster/:id", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const id = cek.wajibUuid(c.req.param("id"), "id");
      cek.selesai();
      return c.json(await baca.detailCluster(id, konteks(p)));
    })

    .get("/cluster/:id/anggota", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const id = cek.wajibUuid(c.req.param("id"), "id");
      const padaTanggal = cek.opsionalTanggal(q(c.req.query("padaTanggal")), "padaTanggal");
      cek.selesai();
      return c.json({ data: await baca.anggotaCluster(id, konteks(p), { padaTanggal }) });
    })

    .post("/cluster/:id/anggota", ...ubah("pumk.cluster"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const input = {
        clusterId: cek.wajibUuid(c.req.param("id"), "id"),
        mitraId: cek.wajibUuid(b.mitraId, "mitraId"),
        tanggalMasuk: cek.wajibTanggal(b.tanggalMasuk, "tanggalMasuk"),
      };
      cek.selesai();
      return c.json(await engine.tambahAnggotaCluster(input, konteks(p)), 201);
    })

    .post("/cluster/:id/anggota/keluar", ...ubah("pumk.cluster"), async (c) => {
      const p = requirePrincipal(c);
      const b = await tubuh(c);
      const cek = new Pemeriksa();
      const input = {
        clusterId: cek.wajibUuid(c.req.param("id"), "id"),
        mitraId: cek.wajibUuid(b.mitraId, "mitraId"),
        tanggalKeluar: cek.wajibTanggal(b.tanggalKeluar, "tanggalKeluar"),
        alasan: cek.wajibTeks(b.alasan, "alasan", 500),
      };
      cek.selesai();
      return c.json(await engine.keluarkanAnggotaCluster(input, konteks(p)));
    })

    // --------------------------------------------------------- kartu piutang
    .get("/kartu-piutang/:akadId", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const id = cek.wajibUuid(c.req.param("akadId"), "akadId");
      cek.selesai();
      return c.json(await engine.kartuPiutang(id, konteks(p)));
    })

    // ----------------------------------------------------------------- mitra
    .get("/mitra", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const input = {
        cari: q(c.req.query("cari")),
        cabangId: cek.opsionalUuid(q(c.req.query("cabangId")), "cabangId"),
      };
      cek.selesai();
      return c.json({ data: await baca.cariMitra(input, konteks(p)) });
    })

    .get("/mitra/:id", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const id = cek.wajibUuid(c.req.param("id"), "id");
      cek.selesai();
      return c.json(await baca.detailMitra(id, konteks(p)));
    })

    // -------------------------------------------------------------- lampiran
    //
    // Stores ONE attachment and answers the path the engine's `lampiranFoto`
    // and `pathDokumen` columns hold. The key is generated here and the
    // client's filename never becomes part of it: an uploaded name is
    // attacker-controlled and has no business steering a storage path.
    .post("/lampiran", ...ubah("pumk.create"), async (c) => {
      const p = requirePrincipal(c);
      const form = await c.req.parseBody().catch(() => null);
      if (!form) throw badRequest("Unggahan tidak terbaca", { file: ["wajib multipart/form-data"] });

      const berkas = form.file;
      const konteksNilai = typeof form.konteks === "string" ? form.konteks : "";
      const galat: Record<string, string[]> = {};
      if (!(berkas instanceof File)) galat.file = ["wajib satu berkas"];
      if (!KONTEKS_LAMPIRAN.test(konteksNilai)) {
        galat.konteks = ["wajib huruf kecil, angka atau tanda hubung, maksimal 41 karakter"];
      }
      if (Object.keys(galat).length > 0) throw badRequest("Unggahan belum valid", galat);

      const file = berkas as File;
      const ekstensi = MIME_LAMPIRAN.get(file.type);
      if (!ekstensi) {
        throw badRequest("Jenis berkas tidak didukung", {
          file: [`wajib salah satu dari: ${[...MIME_LAMPIRAN.keys()].join(", ")}`],
        });
      }
      if (file.size <= 0 || file.size > MAX_LAMPIRAN_BYTES) {
        throw badRequest("Ukuran berkas tidak valid", {
          file: [`maksimal ${MAX_LAMPIRAN_BYTES} byte`],
        });
      }

      const isi = new Uint8Array(await file.arrayBuffer());
      const kunci =
        `pumk/${p.bumnId}/${konteksNilai}/${new Date().toISOString().slice(0, 10)}/` +
        `${crypto.randomUUID()}.${ekstensi}`;
      await penyimpanan.putObject(kunci, isi);
      return c.json({ path: kunci }, 201);
    })

    // A 404 that is the API's own, in the API's own envelope, rather than
    // Hono's plain-text default: apps/web/src/api/http.ts branches on the JSON
    // body and a bare text 404 would be reported as "the server did not
    // answer" instead of "that path does not exist".
    .all("/*", () => {
      throw notFound("Endpoint PUMK tidak ditemukan");
    });
}
