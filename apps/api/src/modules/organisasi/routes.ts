// Hono router for /organisasi. Reads plus the administration write paths for
// users, branches and employees (spec 9.3, spec 9.4).
//
// PERMISSIONS, and the split is deliberate
//
//   READS                 `dashboard.view`. Every role in spec 2 has it,
//                         including the Auditor: the branch and employee lists
//                         are what the rest of the UI labels its data with. The
//                         CONTROL on a read is the branch scope, not the code.
//
//   /pengguna*            `konfigurasi.user`. Held by ADMIN_PUSAT and by
//                         ADMIN_CABANG, because onboarding somebody into a
//                         branch is branch work. What keeps a branch admin from
//                         minting itself a head-office account is NOT this code
//                         but ./peran.ts, which refuses any grant that would
//                         widen the granter's own authority.
//
//   /cabang, /karyawan    `konfigurasi.master`. ADMIN_PUSAT only. Spec 2 puts
//   writes                master data with head office, and a branch that can
//                         create branches can create the scope it is bound to.
//
// EVERY WRITE IS ALSO BEHIND `rejectReadOnlyMutation`, which is redundant with
// the global `enforceReadOnlyRoles` in core/app.ts and stays anyway: the global
// guard is what makes an unwritten route safe, and the local one is what makes
// this file readable as a policy.
import { Hono } from "hono";
import { badRequest } from "../../core/http";
import { requirePrincipal, type Guards } from "../../core/principal";
import type { OrganisasiAdminService } from "./admin-service";
import type { OrganisasiService } from "./service";

/** Parsed JSON body, or an empty object. A malformed body is never a 500. */
async function badan(c: { req: { json: <T>() => Promise<T> } }): Promise<Record<string, unknown>> {
  const parsed = await c.req.json<unknown>().catch(() => ({}));
  return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

function boolWajib(nilai: unknown, field: string): boolean {
  if (typeof nilai !== "boolean") {
    throw badRequest("Data yang dikirim belum valid", { [field]: ["wajib true atau false"] });
  }
  return nilai;
}

export function createOrganisasiRoutes(
  service: OrganisasiService,
  admin: OrganisasiAdminService,
  guards: Guards,
) {
  const lihat = [guards.requireSession, guards.requirePermission("dashboard.view")] as const;
  const kelolaUser = [
    guards.requireSession,
    guards.rejectReadOnlyMutation,
    guards.requirePermission("konfigurasi.user"),
  ] as const;
  /**
   * READING the user list is `konfigurasi.user` OR `audit.view`, and the second
   * one is deliberate.
   *
   * `audit_log` stores an actor as a bare `user_id` and resolves no name
   * (modules/audit/repo.ts), so an Auditor reading the trail sees UUIDs. Spec 2
   * gives that role "read only penuh termasuk ... audit trail", and a trail
   * whose actors cannot be resolved to people is not a readable trail. The
   * WRITE paths stay on `konfigurasi.user` alone, and the Auditor is refused
   * every one of them structurally by method anyway.
   */
  const bacaUser = [
    guards.requireSession,
    guards.requirePermission("konfigurasi.user", "audit.view"),
  ] as const;
  const kelolaMaster = [
    guards.requireSession,
    guards.rejectReadOnlyMutation,
    guards.requirePermission("konfigurasi.master"),
  ] as const;

  return (
    new Hono()
      // ------------------------------------------------------------- cabang
      .get("/cabang", ...lihat, async (c) => {
        return c.json({ data: await service.listCabang(requirePrincipal(c)) });
      })
      .post("/cabang", ...kelolaMaster, async (c) => {
        const p = requirePrincipal(c);
        const b = await badan(c);
        return c.json(
          await admin.buatCabang(p, {
            kode: typeof b.kode === "string" ? b.kode : "",
            nama: typeof b.nama === "string" ? b.nama : "",
            alamat: typeof b.alamat === "string" ? b.alamat : null,
            kotaId: typeof b.kotaId === "string" ? b.kotaId : null,
            isPusat: b.isPusat === true,
          }),
          201,
        );
      })
      .get("/cabang/:id", ...lihat, async (c) => {
        return c.json(await service.getCabang(requirePrincipal(c), c.req.param("id")));
      })
      .patch("/cabang/:id", ...kelolaMaster, async (c) => {
        const p = requirePrincipal(c);
        const b = await badan(c);
        // A BRANCH IS NEVER RENUMBERED. `cabang.kode` is inside every document
        // number the branch has ever issued (`nomor_urut.format_template`), so
        // changing it silently re-parents a decade of paper. Refused here with
        // the reason, rather than accepted and quietly ignored by the repo.
        if (b.kode !== undefined) {
          throw badRequest(
            "Kode cabang tidak dapat diubah: kode itu sudah tercetak di setiap nomor dokumen " +
              "yang pernah diterbitkan cabang ini.",
            { kode: ["tidak dapat diubah"] },
          );
        }
        if (b.isPusat !== undefined) {
          throw badRequest(
            "Status kantor pusat tidak dapat dipindahkan lewat perubahan data cabang.",
            { isPusat: ["tidak dapat diubah"] },
          );
        }
        return c.json(
          await admin.ubahCabang(p, c.req.param("id"), {
            nama: typeof b.nama === "string" ? b.nama : null,
            alamat: typeof b.alamat === "string" ? b.alamat : null,
            kotaId: typeof b.kotaId === "string" ? b.kotaId : null,
            version: typeof b.version === "number" ? b.version : null,
          }),
        );
      })
      .post("/cabang/:id/status", ...kelolaMaster, async (c) => {
        const p = requirePrincipal(c);
        const b = await badan(c);
        return c.json(await admin.setAktifCabang(p, c.req.param("id"), boolWajib(b.aktif, "aktif")));
      })

      // ------------------------------------------------------------ karyawan
      .get("/karyawan", ...lihat, async (c) => {
        const cabangId = c.req.query("cabangId");
        return c.json({ data: await service.listKaryawan(requirePrincipal(c), cabangId) });
      })
      .post("/karyawan", ...kelolaMaster, async (c) => {
        const p = requirePrincipal(c);
        const b = await badan(c);
        return c.json(
          await admin.buatKaryawan(p, {
            cabangId: typeof b.cabangId === "string" ? b.cabangId : "",
            nama: typeof b.nama === "string" ? b.nama : "",
            nip: typeof b.nip === "string" ? b.nip : null,
            jabatan: typeof b.jabatan === "string" ? b.jabatan : null,
            unit: typeof b.unit === "string" ? b.unit : null,
          }),
          201,
        );
      })
      .get("/karyawan/:id", ...lihat, async (c) => {
        return c.json(await service.getKaryawan(requirePrincipal(c), c.req.param("id")));
      })
      .patch("/karyawan/:id", ...kelolaMaster, async (c) => {
        const p = requirePrincipal(c);
        const b = await badan(c);
        return c.json(
          await admin.ubahKaryawan(p, c.req.param("id"), {
            nama: typeof b.nama === "string" ? b.nama : null,
            nip: typeof b.nip === "string" ? b.nip : null,
            jabatan: typeof b.jabatan === "string" ? b.jabatan : null,
            unit: typeof b.unit === "string" ? b.unit : null,
            cabangId: typeof b.cabangId === "string" ? b.cabangId : null,
            version: typeof b.version === "number" ? b.version : null,
          }),
        );
      })
      .post("/karyawan/:id/status", ...kelolaMaster, async (c) => {
        const p = requirePrincipal(c);
        const b = await badan(c);
        return c.json(await admin.setAktifKaryawan(p, c.req.param("id"), boolWajib(b.aktif, "aktif")));
      })

      // ------------------------------------------------------------- peran
      //
      // Registered BEFORE /pengguna/:id so the literal segment can never be
      // read as an id. It answers what THIS caller may grant, annotated with
      // the reason for every option it may not, so the screen can disable an
      // option and say why instead of letting a 403 explain it after the fact.
      .get("/peran", ...bacaUser, (c) => {
        return c.json({ data: admin.peranTersedia(requirePrincipal(c)) });
      })

      // ----------------------------------------------------------- pengguna
      .get("/pengguna", ...bacaUser, async (c) => {
        return c.json({ data: await admin.listPengguna(requirePrincipal(c)) });
      })
      .post("/pengguna", ...kelolaUser, async (c) => {
        const p = requirePrincipal(c);
        const b = await badan(c);
        const hasil = await admin.buatPengguna(p, {
          username: typeof b.username === "string" ? b.username : "",
          nama: typeof b.nama === "string" ? b.nama : "",
          email: typeof b.email === "string" ? b.email : "",
          nip: typeof b.nip === "string" ? b.nip : null,
          cabangId: typeof b.cabangId === "string" ? b.cabangId : "",
          peran: Array.isArray(b.peran) ? (b.peran as { kode: string; scopeCabangId?: string }[]) : [],
        });
        // `no-store`: the body carries a live credential for one handover, and
        // a cached copy in a proxy or a browser is a second copy of it.
        c.header("Cache-Control", "no-store");
        return c.json(hasil, 201);
      })
      .get("/pengguna/:id", ...bacaUser, async (c) => {
        return c.json(await admin.getPengguna(requirePrincipal(c), c.req.param("id")));
      })
      .patch("/pengguna/:id", ...kelolaUser, async (c) => {
        const p = requirePrincipal(c);
        const b = await badan(c);
        if (b.username !== undefined) {
          // A username is what `audit_log` and every `created_by` trail is read
          // back through by a human. Renaming one makes old evidence point at a
          // name nobody recognises. Deactivate and issue a new account instead.
          throw badRequest(
            "Nama pengguna tidak dapat diubah. Nonaktifkan akun ini dan terbitkan akun baru " +
              "kalau orangnya berganti.",
            { username: ["tidak dapat diubah"] },
          );
        }
        if (b.peran !== undefined) {
          throw badRequest("Peran diubah lewat PUT /organisasi/pengguna/:id/peran", {
            peran: ["gunakan endpoint peran"],
          });
        }
        return c.json(
          await admin.ubahPengguna(p, c.req.param("id"), {
            nama: typeof b.nama === "string" ? b.nama : null,
            email: typeof b.email === "string" ? b.email : null,
            nip: typeof b.nip === "string" ? b.nip : null,
            cabangId: typeof b.cabangId === "string" ? b.cabangId : null,
            version: typeof b.version === "number" ? b.version : null,
          }),
        );
      })
      .put("/pengguna/:id/peran", ...kelolaUser, async (c) => {
        const p = requirePrincipal(c);
        const b = await badan(c);
        if (!Array.isArray(b.peran)) {
          throw badRequest("Data yang dikirim belum valid", { peran: ["wajib berupa array"] });
        }
        return c.json(
          await admin.gantiPeran(
            p,
            c.req.param("id"),
            b.peran as { kode: string; scopeCabangId?: string }[],
          ),
        );
      })
      .post("/pengguna/:id/status", ...kelolaUser, async (c) => {
        const p = requirePrincipal(c);
        const b = await badan(c);
        return c.json(
          await admin.setAktifPengguna(
            p,
            c.req.param("id"),
            boolWajib(b.aktif, "aktif"),
            typeof b.alasan === "string" ? b.alasan.slice(0, 500) : null,
          ),
        );
      })
      .post("/pengguna/:id/sandi-sementara", ...kelolaUser, async (c) => {
        const hasil = await admin.resetSandi(requirePrincipal(c), c.req.param("id"));
        c.header("Cache-Control", "no-store");
        return c.json(hasil);
      })
  );
}
