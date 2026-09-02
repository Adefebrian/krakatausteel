// Hono router for /impor (spec 9.6, the writing half of the tools).
//
// TWO ROUTES PER KIND, AND THE SPLIT IS THE PRODUCT. Spec 9.6: "preview hasil
// parsing, validasi per baris, tampilkan baris yang error dengan alasan, baru
// commit yang valid ... Jangan pernah commit sebagian tanpa laporan eksplisit
// ke user." So:
//
//   POST /impor/:jenis/pratinjau   parses and validates, writes NOTHING, and
//                                  answers with every rejection and its line
//                                  number. 200 even when rows are rejected:
//                                  the report IS the successful result of a
//                                  preview.
//
//   POST /impor/:jenis/komit       all or nothing. Refuses with 400
//                                  ADA_BARIS_DITOLAK and the same rejection
//                                  list if any row is bad, and nothing at all
//                                  is written.
//
// The four rules modules/rka and modules/tools state hold here too: validate
// at the boundary before any engine call; authorise with CANONICAL codes so a
// typo is a boot failure; never let the request decide scope (the engine
// intersects the requested branch with the session's); never catch a domain
// error, so `ImporError` reaches core/http.ts and the DITOLAK audit row of
// spec 2 rule 5 gets written.
//
// THE BODY IS JSON WITH THE FILE'S TEXT IN IT, not multipart. It keeps the
// global 1 MB body cap (core/hardening.ts) as the outer bound, keeps the
// module's own 512 KB text cap as the inner one, and means nothing in this
// request path ever touches the object store.
import { Hono } from "hono";
import type { Context } from "hono";
import { badRequest, notFound } from "../../core/http";
import { requirePrincipal, type Guards, type Principal } from "../../core/principal";
import {
  JENIS_IMPOR,
  KODE_IMPOR,
  MAKS_ISI_BYTE,
  type ImporContext,
  type ImporEngine,
  type JenisImpor,
  type PermintaanImpor,
} from "./contract";

const POLA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ImporRoutesDeps {
  engine: ImporEngine;
  guards: Guards;
}

/** The session's own authority. Nothing from the request reaches this. */
function konteks(p: Principal): ImporContext {
  return {
    userId: p.userId,
    cabangId: p.cabang.id,
    bumnId: p.bumnId,
    permissions: p.permissions,
    // Empty for a cross-branch role, which the engine reads as "no branch
    // restriction", matching core/principal.ts's `allowedCabangIds`.
    cabangDalamScope: p.lintasCabang ? [] : p.cabangTersedia.map((c) => c.id),
  };
}

async function permintaan(c: Context): Promise<PermintaanImpor> {
  const jenisMentah = c.req.param("jenis") ?? "";
  const galat: Record<string, string[]> = {};
  const jenis = (JENIS_IMPOR as readonly string[]).includes(jenisMentah)
    ? (jenisMentah as JenisImpor)
    : null;
  if (!jenis) galat.jenis = [`wajib salah satu dari: ${JENIS_IMPOR.join(", ")}`];

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const isi = typeof body.isi === "string" ? body.isi : null;
  if (isi === null || isi.length === 0) galat.isi = ["wajib diisi dengan isi berkas CSV"];
  else if (new TextEncoder().encode(isi).length > MAKS_ISI_BYTE) {
    galat.isi = [`maksimal ${Math.floor(MAKS_ISI_BYTE / 1024)} KB`];
  }

  const namaFile = typeof body.namaFile === "string" ? body.namaFile : "";
  if (namaFile.length > 160) galat.namaFile = ["maksimal 160 karakter"];

  const cabangId = typeof body.cabangId === "string" && body.cabangId.length > 0 ? body.cabangId : null;
  if (cabangId !== null && !POLA_UUID.test(cabangId)) galat.cabangId = ["wajib berupa UUID"];

  if (Object.keys(galat).length > 0) throw badRequest("Data yang dikirim belum valid", galat);

  return { jenis: jenis!, berkas: { namaFile, isi: isi! }, cabangId };
}

export function createImporRoutes({ engine, guards }: ImporRoutesDeps) {
  const unggah = [guards.requireSession, guards.requirePermission("tools.import")] as const;

  return new Hono()
    .post("/:jenis/pratinjau", ...unggah, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await engine.pratinjau(await permintaan(c), konteks(p)));
    })

    /**
     * ALL OR NOTHING. A file with a bad row is answered 400 WITH THE WHOLE
     * REJECTION REPORT, in the API's own envelope plus a `laporan` field, and
     * nothing at all has been written. Spec 9.6 makes that report the product
     * of the refusal, and an error body here carries a message and a code
     * only; see `HasilKomitAtauTolak` in ./contract.ts for why the engine
     * returns this case instead of throwing it.
     */
    .post("/:jenis/komit", ...unggah, async (c) => {
      const p = requirePrincipal(c);
      const hasil = await engine.komit(await permintaan(c), konteks(p));
      if (!hasil.ok) {
        return c.json(
          {
            error:
              "Ada baris yang ditolak, jadi tidak ada satu baris pun yang disimpan. " +
              "Perbaiki berkasnya lalu unggah ulang.",
            code: "VALIDASI" as const,
            kodeDomain: KODE_IMPOR.ADA_BARIS_DITOLAK,
            laporan: hasil.laporan,
          },
          400,
        );
      }
      return c.json(hasil.hasil, 201);
    })

    // The API's own 404 in the API's own envelope, rather than Hono's plain
    // text default: apps/web/src/api/http.ts branches on the JSON body.
    .all("/*", () => {
      throw notFound("Endpoint impor tidak ditemukan");
    });
}
