// Hono router for /konfigurasi (spec 9.4). Validation at the boundary, the
// service does the rest.
//
// PERMISSIONS
//   GET   konfigurasi.parameter OR audit.view  -- the Auditor has read-only
//         access to everything (spec 2), and the parameter set is part of the
//         evidence for how a number was calculated, so it must be visible to
//         them without granting the editor permission.
//   PUT   konfigurasi.update (alias of konfigurasi.parameter). Held by Admin
//         Pusat only; Admin Cabang has konfigurasi.user and not this one,
//         because spec 2 puts master data with Admin Pusat.
import { Hono } from "hono";
import { badRequest } from "../../core/http";
import { clientIp } from "../../core/hardening";
import { requirePrincipal, type Guards } from "../../core/principal";
import type { KonfigurasiService } from "./service";

const MAX_NILAI_LENGTH = 2000;

export function createKonfigurasiRoutes(service: KonfigurasiService, guards: Guards) {
  return new Hono()
    .get("/", guards.requireSession, guards.requirePermission("konfigurasi.parameter", "audit.view"), async (c) => {
      const principal = requirePrincipal(c);
      return c.json({ data: await service.semua(principal.bumnId) });
    })

    .get(
      "/:grup/:kunci",
      guards.requireSession,
      guards.requirePermission("konfigurasi.parameter", "audit.view"),
      async (c) => {
        const principal = requirePrincipal(c);
        return c.json(await service.satu(principal.bumnId, c.req.param("grup"), c.req.param("kunci")));
      },
    )

    .put(
      "/:grup/:kunci",
      guards.requireSession,
      guards.rejectReadOnlyMutation,
      guards.requirePermission("konfigurasi.update"),
      async (c) => {
        const principal = requirePrincipal(c);
        const body = await c.req
          .json<{ nilai?: unknown; version?: unknown; alasan?: unknown }>()
          .catch((): Record<string, unknown> => ({}));

        if (typeof body.nilai !== "string" || body.nilai.length > MAX_NILAI_LENGTH) {
          throw badRequest("Field nilai wajib berupa string", {
            nilai: [`wajib string, maksimal ${MAX_NILAI_LENGTH} karakter`],
          });
        }
        let version: number | undefined;
        if (body.version !== undefined) {
          if (typeof body.version !== "number" || !Number.isInteger(body.version) || body.version < 1) {
            throw badRequest("Field version harus bilangan bulat positif", {
              version: ["harus bilangan bulat positif"],
            });
          }
          version = body.version;
        }

        const hasil = await service.update({
          bumnId: principal.bumnId,
          grup: c.req.param("grup"),
          kunci: c.req.param("kunci"),
          nilai: body.nilai,
          userId: principal.userId,
          version,
          ip: clientIp(c),
          userAgent: (c.req.header("user-agent") ?? null)?.slice(0, 512) ?? null,
          alasan: typeof body.alasan === "string" ? body.alasan.slice(0, 500) : null,
        });
        return c.json(hasil, 200);
      },
    );
}
