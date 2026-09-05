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
//   /coa*          `konfigurasi.coa`. ADMIN_PUSAT only. The chart of accounts
//                  is what every statement is assembled from, and repointing an
//                  account is closer to a code change than to data entry.
//   /master/*      `konfigurasi.master` to WRITE, `pumk.view OR konfigurasi.master`
//                  to READ. The read is wide because the operational screens
//                  render these lists to label their own data; the write is head
//                  office, per spec 2.
//
// ROUTE ORDER MATTERS IN THIS FILE, and it is the reason the shape below is not
// the obvious one. `/:grup/:kunci` matches ANY two segments, so it would
// swallow `/master/sektor` and answer it as a parameter lookup that does not
// exist. Hono resolves in registration order, so every literal path is
// registered FIRST and the two-segment parameter route is registered LAST. A
// new endpoint under /konfigurasi goes above it, never below.
//
//   GET   /sektor and /akun are REFERENCE LISTS, not parameters, and are gated
//         on `pumk.view` OR `konfigurasi.coa`: the operational screens that
//         need them (the proposal filter, the cash-account picker on a
//         disbursement or a receipt) are held by the Maker, who has no business
//         with the parameter set. Putting them behind `konfigurasi.coa` would
//         have meant only Admin Pusat could pick a cash account, which is not
//         a policy anyone chose.
import { Hono } from "hono";
import { badRequest } from "../../core/http";
import { clientIp } from "../../core/hardening";
import { requirePrincipal, type Guards } from "../../core/principal";
import type { KonfigurasiAdminService } from "./admin-service";
import type { KonfigurasiService } from "./service";

const MAX_NILAI_LENGTH = 2000;

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

export function createKonfigurasiRoutes(
  service: KonfigurasiService,
  admin: KonfigurasiAdminService,
  guards: Guards,
) {
  const bacaCoa = [guards.requireSession, guards.requirePermission("konfigurasi.coa")] as const;
  const tulisCoa = [
    guards.requireSession,
    guards.rejectReadOnlyMutation,
    guards.requirePermission("konfigurasi.coa"),
  ] as const;
  const bacaMaster = [
    guards.requireSession,
    guards.requirePermission("konfigurasi.master", "pumk.view"),
  ] as const;
  const tulisMaster = [
    guards.requireSession,
    guards.rejectReadOnlyMutation,
    guards.requirePermission("konfigurasi.master"),
  ] as const;

  return new Hono()
    .get("/", guards.requireSession, guards.requirePermission("konfigurasi.parameter", "audit.view"), async (c) => {
      const principal = requirePrincipal(c);
      return c.json({ data: await service.semua(principal.bumnId) });
    })

    // --------------------------------------------------------- chart of accounts
    .get("/coa", ...bacaCoa, async (c) => {
      return c.json({ data: await admin.listAkun(requirePrincipal(c)) });
    })
    .post("/coa", ...tulisCoa, async (c) => {
      const p = requirePrincipal(c);
      const b = await badan(c);
      return c.json(
        await admin.buatAkun(p, {
          kode: typeof b.kode === "string" ? b.kode : "",
          nama: typeof b.nama === "string" ? b.nama : "",
          parentId: typeof b.parentId === "string" ? b.parentId : null,
          level: typeof b.level === "number" ? b.level : Number.NaN,
          tipe: typeof b.tipe === "string" ? b.tipe : "",
          saldoNormal: typeof b.saldoNormal === "string" ? b.saldoNormal : "",
          isPostable: b.isPostable === true,
          isKas: b.isKas === true,
          isKontra: b.isKontra === true,
          klasifikasiArusKas: typeof b.klasifikasiArusKas === "string" ? b.klasifikasiArusKas : null,
          klasifikasiAkun: typeof b.klasifikasiAkun === "string" ? b.klasifikasiAkun : "",
        }),
        201,
      );
    })
    /** The classification vocabulary a COA form picks from (migrations/0028). */
    .get("/klasifikasi-akun", ...bacaCoa, async (c) => {
      return c.json({ data: await admin.listKlasifikasi(requirePrincipal(c)) });
    })
    .get("/coa/:id", ...bacaCoa, async (c) => {
      return c.json(await admin.getAkun(requirePrincipal(c), c.req.param("id")));
    })
    .patch("/coa/:id", ...tulisCoa, async (c) => {
      const p = requirePrincipal(c);
      const b = await badan(c);
      // THE IDENTITY AND THE POSITION OF AN ACCOUNT ARE NOT EDITABLE.
      // `kode` is what `event_jurnal_mapping`, the report seed and every
      // reconciliation view name the account by; `parentId`, `level` and `tipe`
      // are where it sits in the statement. Changing any of them re-states what
      // an already posted journal meant. The remedy is a new account plus a
      // deactivation, which leaves both readings visible to whoever reads the
      // history.
      for (const terlarang of ["kode", "parentId", "level", "tipe", "saldoNormal"]) {
        if (b[terlarang] !== undefined) {
          throw badRequest(
            `Field ${terlarang} tidak dapat diubah pada akun yang sudah ada: nilai itu adalah ` +
              "identitas atau posisi akun di laporan, dan riwayat yang sudah diposting " +
              "menunjuk padanya. Buat akun baru lalu nonaktifkan yang lama.",
            { [terlarang]: ["tidak dapat diubah"] },
          );
        }
      }
      return c.json(
        await admin.ubahAkun(p, c.req.param("id"), {
          nama: typeof b.nama === "string" ? b.nama : null,
          isKas: typeof b.isKas === "boolean" ? b.isKas : null,
          isKontra: typeof b.isKontra === "boolean" ? b.isKontra : null,
          isPostable: typeof b.isPostable === "boolean" ? b.isPostable : null,
          klasifikasiArusKas: typeof b.klasifikasiArusKas === "string" ? b.klasifikasiArusKas : null,
          klasifikasiAkun: typeof b.klasifikasiAkun === "string" ? b.klasifikasiAkun : null,
          version: typeof b.version === "number" ? b.version : null,
        }),
      );
    })
    .post("/coa/:id/status", ...tulisCoa, async (c) => {
      const p = requirePrincipal(c);
      const b = await badan(c);
      return c.json(await admin.setAktifAkun(p, c.req.param("id"), boolWajib(b.aktif, "aktif")));
    })

    // ------------------------------------------------------------ master data
    .get("/master", ...bacaMaster, (c) => {
      return c.json({ data: admin.daftarJenisMaster() });
    })
    .get("/master/:jenis", ...bacaMaster, async (c) => {
      return c.json({
        jenis: c.req.param("jenis"),
        data: await admin.listMaster(requirePrincipal(c), c.req.param("jenis")),
      });
    })
    .post("/master/:jenis", ...tulisMaster, async (c) => {
      return c.json(
        await admin.buatMaster(requirePrincipal(c), c.req.param("jenis"), await badan(c)),
        201,
      );
    })
    .patch("/master/:jenis/:id", ...tulisMaster, async (c) => {
      return c.json(
        await admin.ubahMaster(
          requirePrincipal(c),
          c.req.param("jenis"),
          c.req.param("id"),
          await badan(c),
        ),
      );
    })
    .post("/master/:jenis/:id/status", ...tulisMaster, async (c) => {
      const b = await badan(c);
      return c.json(
        await admin.setAktifMaster(
          requirePrincipal(c),
          c.req.param("jenis"),
          c.req.param("id"),
          boolWajib(b.aktif, "aktif"),
        ),
      );
    })

    // Master data the operational forms pick from. Read only, and deliberately
    // ONE segment so it cannot collide with `/:grup/:kunci` below.
    .get("/sektor", guards.requireSession, guards.requirePermission("pumk.view", "konfigurasi.coa"), async (c) => {
      const principal = requirePrincipal(c);
      return c.json({ data: await service.sektor(principal.bumnId) });
    })

    .get("/akun", guards.requireSession, guards.requirePermission("pumk.view", "konfigurasi.coa"), async (c) => {
      const principal = requirePrincipal(c);
      // `?kas=true` is the only filter this endpoint offers, and it is
      // MANDATORY: the full chart of accounts is a different screen with a
      // different permission (spec 9.4), and answering it here by omission
      // would be a quiet privilege widening.
      if (c.req.query("kas") !== "true") {
        throw badRequest("Filter kas=true wajib", { kas: ["wajib bernilai true"] });
      }
      return c.json({ data: await service.akunKas(principal.bumnId) });
    })

    // REGISTERED LAST, both of them: two segments each, so they match every
    // path above too. See the ROUTE ORDER note in the file header.
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
