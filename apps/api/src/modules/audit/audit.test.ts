// Audit trail tests. Spec 4.10 for the shape, spec 2 rule 5 for the reason
// (every authorisation denial is recorded), spec 10.4 report 31 for the
// property that nobody can delete it.
import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createDbAdapter } from "../../core/adapters/db";
import type { QueryRunner } from "./ports";
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

describe("the payload is stored as queryable jsonb, not as a string scalar", () => {
  // THE REGRESSION THIS PINS. `$n::jsonb` bound from a JS string behaves
  // differently per driver: node-postgres stores an object, bun:sql stores a
  // JSON STRING SCALAR. In the scalar case the row still looks right in a
  // listing and `nilai_baru_json->>'key'` silently returns NULL, so every
  // before/after comparison and every filter on the audit-trail report (spec
  // 10.4 #31) quietly finds nothing. The repo therefore binds
  // `$n::text::jsonb`, and these tests assert on the INSIDE of the payload,
  // because the earlier tests passed against the bug by only ever looking at
  // `aksi`, `entitas_id` and `hasil`.

  async function bacaPayload(entitasId: string, runner = db) {
    return (
      await runner.query<{
        tipe_lama: string | null;
        tipe_baru: string | null;
        status_lama: string | null;
        status_baru: string | null;
        nested: string | null;
      }>(
        `SELECT jsonb_typeof(nilai_lama_json) AS tipe_lama,
                jsonb_typeof(nilai_baru_json) AS tipe_baru,
                nilai_lama_json->>'status'    AS status_lama,
                nilai_baru_json->>'status'    AS status_baru,
                nilai_baru_json#>>'{detail,plafon}' AS nested
           FROM audit_log WHERE entitas_id = $1`,
        [entitasId],
      )
    )[0];
  }

  test("through the pooled adapter: jsonb_typeof is object and keys resolve", async () => {
    const entitasId = crypto.randomUUID();
    await audit.record({
      aksi: "uji.jsonb",
      entitas: "pumk_proposal",
      entitasId,
      nilaiLama: { status: "DRAFT" },
      nilaiBaru: { status: "DISETUJUI", detail: { plafon: "25000000.00" } },
      hasil: "SUKSES",
    });
    const row = await bacaPayload(entitasId);
    expect(row).toMatchObject({
      tipe_lama: "object",
      tipe_baru: "object",
      status_lama: "DRAFT",
      status_baru: "DISETUJUI",
      nested: "25000000.00",
    });
  });

  test("through a bun:sql runner, which is where the scalar bug came from", async () => {
    // The journal engine builds its own transactional port on bun:sql and can
    // hand it to `audit.record(entry, tx)`, so the repo has to be correct under
    // BOTH drivers, not just the one core/adapters/db.ts uses.
    const sql = new SQL(process.env.DATABASE_URL ?? "");
    const runner: QueryRunner = {
      async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
        return (await sql.unsafe(text, params as never[])) as T[];
      },
    };
    try {
      const entitasId = crypto.randomUUID();
      await audit.record(
        {
          aksi: "uji.jsonb.bunsql",
          entitas: "pumk_proposal",
          entitasId,
          nilaiLama: { status: "DRAFT" },
          nilaiBaru: { status: "DISETUJUI", detail: { plafon: "25000000.00" } },
          hasil: "SUKSES",
        },
        runner,
      );
      const row = await bacaPayload(entitasId);
      expect(row!.tipe_baru).toBe("object");
      expect(row!.tipe_lama).toBe("object");
      expect(row!.status_baru).toBe("DISETUJUI");
      expect(row!.nested).toBe("25000000.00");
    } finally {
      await sql.end();
    }
  });

  test("an array payload stays an array, and null stays SQL NULL", async () => {
    const entitasId = crypto.randomUUID();
    await audit.record({
      aksi: "uji.jsonb.array",
      entitas: "sesi",
      entitasId,
      nilaiBaru: ["MAKER", "CHECKER"],
      hasil: "SUKSES",
    });
    const rows = await db.query<{ tipe: string | null; lama: string | null; pertama: string | null }>(
      `SELECT jsonb_typeof(nilai_baru_json) AS tipe,
              jsonb_typeof(nilai_lama_json) AS lama,
              nilai_baru_json->>0 AS pertama
         FROM audit_log WHERE entitas_id = $1`,
      [entitasId],
    );
    expect(rows[0]).toMatchObject({ tipe: "array", lama: null, pertama: "MAKER" });
  });

  test("the konfigurasi write path stores a queryable payload too", async () => {
    // Same binding shape, same trap: the before/after values of a parameter
    // change are the evidence for why a number moved.
    const f = await createFixture();
    await f.ctx.konfigurasi.update({
      bumnId: f.bumnId,
      grup: "batasan",
      kunci: "tenor_max_bulan",
      nilai: "18",
      userId: f.users.ADMIN_PUSAT.id,
    });
    const rows = await db.query<{ lama: string | null; baru: string | null; tipe: string | null }>(
      `SELECT nilai_lama_json->>'nilai' AS lama, nilai_baru_json->>'nilai' AS baru,
              jsonb_typeof(nilai_baru_json) AS tipe
         FROM audit_log
        WHERE aksi = 'konfigurasi.update' AND user_id = $1
        ORDER BY id DESC LIMIT 1`,
      [f.users.ADMIN_PUSAT.id],
    );
    expect(rows[0]).toMatchObject({ lama: "36", baru: "18", tipe: "object" });
  });

  test("konfigurasi.pilihan_json is written as a real jsonb array", async () => {
    // The seed writes it with the same cast; an ENUM whose options are a string
    // scalar cannot be rendered as a select box by the config UI.
    const rows = await db.query<{ tipe: string; n: number }>(
      `SELECT jsonb_typeof(pilihan_json) AS tipe, jsonb_array_length(pilihan_json) AS n
         FROM konfigurasi
        WHERE grup = 'akuntansi' AND kunci = 'mode_penyisihan' AND deleted_at IS NULL
        LIMIT 1`,
    );
    expect(rows[0]).toMatchObject({ tipe: "array", n: 2 });
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
