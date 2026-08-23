// Hono router for /organisasi. Read only in Fase 0: master-data writes are a
// later phase (spec 9.3), and shipping a write path before it is specified is
// how an unguarded endpoint gets forgotten.
//
// PERMISSIONS
//   dashboard.view for every read. Every role in spec 2 has it, including the
//   Auditor: the branch and employee lists are what the rest of the UI labels
//   its data with. The CONTROL here is the branch scope, not the permission.
import { Hono } from "hono";
import { requirePrincipal, type Guards } from "../../core/principal";
import type { OrganisasiService } from "./service";

export function createOrganisasiRoutes(service: OrganisasiService, guards: Guards) {
  return new Hono()
    .get("/cabang", guards.requireSession, guards.requirePermission("dashboard.view"), async (c) => {
      return c.json({ data: await service.listCabang(requirePrincipal(c)) });
    })
    .get("/cabang/:id", guards.requireSession, guards.requirePermission("dashboard.view"), async (c) => {
      return c.json(await service.getCabang(requirePrincipal(c), c.req.param("id")));
    })
    .get("/karyawan", guards.requireSession, guards.requirePermission("dashboard.view"), async (c) => {
      const cabangId = c.req.query("cabangId");
      return c.json({ data: await service.listKaryawan(requirePrincipal(c), cabangId) });
    })
    .get("/karyawan/:id", guards.requireSession, guards.requirePermission("dashboard.view"), async (c) => {
      return c.json(await service.getKaryawan(requirePrincipal(c), c.req.param("id")));
    });
}
