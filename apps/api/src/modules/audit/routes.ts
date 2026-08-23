// Hono router for the audit trail. Read only by construction: audit_log has no
// UPDATE or DELETE path anywhere in the codebase (spec 10.4 report 31).
//
// Guards are injected rather than imported from modules/auth, so this module
// depends on core only (see core/principal.ts).
import { Hono } from "hono";
import { badRequest } from "../../core/http";
import type { Guards } from "./ports";
import type { AuditHasil } from "./repo";
import type { AuditService } from "./service";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw badRequest(`limit harus bilangan bulat 1..${MAX_LIMIT}`, { limit: ["di luar rentang"] });
  }
  return value;
}

function parseHasil(raw: string | undefined): AuditHasil | undefined {
  if (raw === undefined) return undefined;
  if (raw !== "SUKSES" && raw !== "DITOLAK") {
    throw badRequest("hasil harus SUKSES atau DITOLAK", { hasil: ["nilai tidak dikenal"] });
  }
  return raw;
}

export function createAuditRoutes(service: AuditService, guards: Guards) {
  return new Hono().get(
    "/",
    guards.requireSession,
    guards.requirePermission("audit.view"),
    async (c) => {
      const rows = await service.list({
        userId: c.req.query("userId"),
        entitas: c.req.query("entitas"),
        entitasId: c.req.query("entitasId"),
        aksi: c.req.query("aksi"),
        hasil: parseHasil(c.req.query("hasil")),
        limit: parseLimit(c.req.query("limit")),
      });
      return c.json({ data: rows });
    },
  );
}
