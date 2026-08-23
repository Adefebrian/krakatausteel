// Audit trail tests. Spec 4.10 for the shape, spec 2 rule 5 for the reason
// (every authorisation denial is recorded), spec 10.4 report 31 for the
// property that nobody can delete it.
import { describe, expect, test } from "bun:test";
import { createDbAdapter } from "../../core/adapters/db";
import { createFixture } from "../../testing/harness";
import { createAuditService } from "./service";

const db = createDbAdapter();
const audit = createAuditService({ db });

describe("append-only, enforced by the database", () => {
  test("an UPDATE is refused", async () => {
    const id = await audit.record({
      aksi: "uji.append",
      entitas: "uji",
      entitasId: crypto.randomUUID(),
      hasil: "SUKSES",
    });
    await expect(
      db.query("UPDATE audit_log SET keterangan = 'diubah' WHERE id = $1", [id]),
    ).rejects.toThrow(/TJSL-AUD-001/);
  });

  test("a DELETE is refused", async () => {
    const id = await audit.record({ aksi: "uji.append", entitas: "uji", hasil: "SUKSES" });
    await expect(db.query("DELETE FROM audit_log WHERE id = $1", [id])).rejects.toThrow(/TJSL-AUD-001/);
  });
});

describe("record", () => {
  test("stores every field spec 4.10 lists", async () => {
    const f = await createFixture();
    const entitasId = crypto.randomUUID();
    await audit.recordFor(
      { userId: f.users.MAKER.id, ip: "203.0.113.9", userAgent: "Uji/1.0" },
      {
        aksi: "uji.lengkap",
        entitas: "pumk_proposal",
        entitasId,
        nilaiLama: { status: "DRAFT" },
        nilaiBaru: { status: "DIAJUKAN" },
        hasil: "SUKSES",
        keterangan: "diajukan ke checker",
      },
    );
    const rows = await db.query<Record<string, unknown>>(
      `SELECT user_id::text AS user_id, host(ip) AS ip, user_agent, aksi, entitas, entitas_id,
              nilai_lama_json, nilai_baru_json, hasil, keterangan, waktu
         FROM audit_log WHERE entitas_id = $1`,
      [entitasId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: f.users.MAKER.id,
      ip: "203.0.113.9",
      user_agent: "Uji/1.0",
      aksi: "uji.lengkap",
      entitas: "pumk_proposal",
      entitas_id: entitasId,
      hasil: "SUKSES",
      keterangan: "diajukan ke checker",
    });
    expect(rows[0]!.nilai_lama_json).toEqual({ status: "DRAFT" });
    expect(rows[0]!.nilai_baru_json).toEqual({ status: "DIAJUKAN" });
    expect(rows[0]!.waktu).toBeDefined();
  });

  test("an anonymous attempt is recorded with a null user, not skipped", async () => {
    const entitasId = crypto.randomUUID();
    await audit.record({
      aksi: "auth.login",
      entitas: "app_user",
      entitasId,
      hasil: "DITOLAK",
      keterangan: "username tidak ditemukan",
    });
    const rows = await db.query<{ user_id: string | null }>(
      "SELECT user_id::text AS user_id FROM audit_log WHERE entitas_id = $1",
      [entitasId],
    );
    expect(rows[0]!.user_id).toBeNull();
  });

  test("an unresolvable IP is stored as NULL, because the column is INET", async () => {
    const entitasId = crypto.randomUUID();
    await audit.recordFor({ ip: null }, { aksi: "uji.ip", entitas: "uji", entitasId, hasil: "SUKSES" });
    const rows = await db.query<{ ip: string | null }>(
      "SELECT host(ip) AS ip FROM audit_log WHERE entitas_id = $1",
      [entitasId],
    );
    expect(rows[0]!.ip).toBeNull();
  });

  test("a failure to write is an error, never swallowed", async () => {
    // hasil is constrained to SUKSES/DITOLAK; a bad value must reject rather
    // than let the action proceed unlogged.
    await expect(
      audit.record({ aksi: "uji", entitas: "uji", hasil: "MUNGKIN" as "SUKSES" }),
    ).rejects.toThrow();
  });
});

describe("GET /audit", () => {
  test("returns rows to a role with audit.view and filters by entity", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.AUDITOR.username);
    const res = await f.request("/audit?entitas=app_user&limit=10", { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { entitas: string }[] };
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((row) => row.entitas === "app_user")).toBe(true);
  });

  test("filters to refusals only, which is the security-relevant slice", async () => {
    const f = await createFixture();
    await f.request("/auth/session"); // generates a DITOLAK row
    const cookie = await f.login(f.users.AUDITOR.username);
    const res = await f.request("/audit?hasil=DITOLAK&limit=5", { cookie });
    const body = (await res.json()) as { data: { hasil: string }[] };
    expect(body.data.every((row) => row.hasil === "DITOLAK")).toBe(true);
  });

  test("rejects an out-of-range limit and an unknown hasil with a 400", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.AUDITOR.username);
    expect((await f.request("/audit?limit=0", { cookie })).status).toBe(400);
    expect((await f.request("/audit?limit=9999", { cookie })).status).toBe(400);
    expect((await f.request("/audit?limit=abc", { cookie })).status).toBe(400);
    expect((await f.request("/audit?hasil=MUNGKIN", { cookie })).status).toBe(400);
  });

  test("has no write surface at all", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await f.request("/audit", { method, cookie, body: { aksi: "palsu" } });
      expect(res.status).toBe(404);
    }
  });
});
