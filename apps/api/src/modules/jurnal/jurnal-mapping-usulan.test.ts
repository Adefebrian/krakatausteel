// Changing `event_jurnal_mapping` through the API, and the maker-checker that
// guards it (migration 0036, ADR 0004).
//
// THE PROPERTY UNDER TEST is not "the endpoint works". It is that ONE PERSON
// CANNOT REPOINT A BUSINESS EVENT. A mapping edit decides what every future
// journal of that event debits and credits, so it needs the same two-person
// control spec 2 puts on a proposal, and it needs the proposal never to be
// readable by the posting engine while it is pending.
import { afterAll, describe, expect, test } from "bun:test";
import { createFixture, tutupSemuaFixture } from "../../testing/harness";
import { seedCoaInti } from "../../seed/coa-inti";
import { seedEventJurnalMapping } from "../../seed/event-jurnal";

afterAll(tutupSemuaFixture);

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/**
 * A fixture with a full chart, a full mapping, and TWO Admin Pusat accounts:
 * the whole point of this file is that one of them cannot act alone.
 */
async function dunia() {
  const f = await createFixture();
  const akunIdByKode = await seedCoaInti(f.db, f.bumnId, f.users.ADMIN_PUSAT.id);
  await seedEventJurnalMapping(f.db, f.bumnId, { akunIdByKode, userId: f.users.ADMIN_PUSAT.id });

  const passwordHash = await f.ctx.auth.service.hashPassword("UjiCoba#12345");
  const username = `pusat2.${f.suffix}`;
  const rows = await f.db.query<{ id: string }>(
    `INSERT INTO app_user (cabang_id, nip, nama, email, username, password_hash, aktif)
     VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id::text AS id`,
    [f.pusat.id, `P2-${f.suffix}`, `Admin Pusat Kedua ${f.suffix}`, `${username}@uji.local`, username, passwordHash],
  );
  const keduaId = rows[0]!.id;
  await f.db.query(
    `INSERT INTO user_role (user_id, role_id)
     SELECT $1, id FROM app_role WHERE kode = 'ADMIN_PUSAT' AND deleted_at IS NULL`,
    [keduaId],
  );

  return {
    f,
    akunIdByKode,
    pengusul: await f.login(f.users.ADMIN_PUSAT.username),
    pemutus: await f.login(username),
    pemutusId: keduaId,
  };
}

describe("GET /jurnal/mapping", () => {
  test("lists what is in force and says which spec 6.4 events have no active mapping", async () => {
    const { f, pengusul } = await dunia();
    const res = await f.request("/jurnal/mapping", { cookie: pengusul });
    expect(res.status).toBe(200);
    const body = await json<{
      data: { eventCode: string; akunDebitKode: string | null; akunKreditKode: string | null }[];
      tanpaPemetaan: string[];
    }>(res);

    const pencairan = body.data.find((m) => m.eventCode === "PENCAIRAN_PUMK");
    expect(pencairan).toBeDefined();
    expect(pencairan!.akunDebitKode).toBe("1.1.03");
    expect(pencairan!.akunKreditKode).toBe("1.1.01");
    // The seed covers every event, so nothing is missing.
    expect(body.tanpaPemetaan).toEqual([]);
  });

  test("is closed to everyone but Admin Pusat", async () => {
    const { f } = await dunia();
    for (const peran of ["APPROVER", "ADMIN_CABANG", "AUDITOR", "MAKER"] as const) {
      const cookie = await f.login(f.users[peran].username);
      expect((await f.request("/jurnal/mapping", { cookie })).status).toBe(403);
    }
  });
});

describe("one person cannot repoint a business event", () => {
  test("a proposal is filed, is not yet in force, and changes no journal", async () => {
    const { f, pengusul, akunIdByKode } = await dunia();
    const res = await f.request("/jurnal/mapping/usulan", {
      method: "POST",
      cookie: pengusul,
      body: {
        eventCode: "PENCAIRAN_PUMK",
        akunDebitId: akunIdByKode.get("1.1.03"),
        akunKreditId: akunIdByKode.get("1.1.02"),
        jenisJurnal: "OTOMATIS",
        alasan: "Pencairan pindah ke bank operasional, bukan kas besar",
      },
    });
    expect(res.status).toBe(201);
    const usulan = await json<{ id: string; status: string }>(res);
    expect(usulan.status).toBe("DIAJUKAN");

    // NOT IN FORCE. The engine reads `event_jurnal_mapping`, and nothing there
    // moved: a pending proposal must be invisible to posting.
    const berlaku = await json<{ data: { eventCode: string; akunKreditKode: string | null }[] }>(
      await f.request("/jurnal/mapping", { cookie: pengusul }),
    );
    expect(berlaku.data.find((m) => m.eventCode === "PENCAIRAN_PUMK")!.akunKreditKode).toBe("1.1.01");
  });

  test("the proposer cannot approve their own proposal", async () => {
    const { f, pengusul, akunIdByKode } = await dunia();
    const usulan = await json<{ id: string }>(
      await f.request("/jurnal/mapping/usulan", {
        method: "POST",
        cookie: pengusul,
        body: {
          eventCode: "PENCAIRAN_PUMK",
          akunDebitId: akunIdByKode.get("1.1.03"),
          akunKreditId: akunIdByKode.get("1.1.02"),
          alasan: "Pencairan pindah ke bank operasional",
        },
      }),
    );
    const res = await f.request(`/jurnal/mapping/usulan/${usulan.id}/setujui`, {
      method: "POST",
      cookie: pengusul,
      body: {},
    });
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("SEGREGASI_TUGAS");
  });

  test("a second Admin Pusat approves it, and only then does the mapping move", async () => {
    const { f, pengusul, pemutus, pemutusId, akunIdByKode } = await dunia();
    const usulan = await json<{ id: string }>(
      await f.request("/jurnal/mapping/usulan", {
        method: "POST",
        cookie: pengusul,
        body: {
          eventCode: "PENCAIRAN_PUMK",
          akunDebitId: akunIdByKode.get("1.1.03"),
          akunKreditId: akunIdByKode.get("1.1.02"),
          alasan: "Pencairan pindah ke bank operasional",
        },
      }),
    );
    const res = await f.request(`/jurnal/mapping/usulan/${usulan.id}/setujui`, {
      method: "POST",
      cookie: pemutus,
      body: { catatan: "Setuju, kas besar sudah ditutup" },
    });
    expect(res.status).toBe(200);

    const berlaku = await json<{ data: { eventCode: string; akunKreditKode: string | null }[] }>(
      await f.request("/jurnal/mapping", { cookie: pengusul }),
    );
    expect(berlaku.data.find((m) => m.eventCode === "PENCAIRAN_PUMK")!.akunKreditKode).toBe("1.1.02");

    // THE SUPERSEDED ROW STAYS. ADR 0004: exactly one mapping is in force at a
    // time while the previous ones remain readable, because "which account did
    // this event credit in July" is a question with a row for an answer.
    const semua = await f.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM event_jurnal_mapping
        WHERE bumn_id = $1 AND event_code = 'PENCAIRAN_PUMK' AND deleted_at IS NULL`,
      [f.bumnId],
    );
    expect(Number(semua[0]!.n)).toBe(2);
    const aktif = await f.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM event_jurnal_mapping
        WHERE bumn_id = $1 AND event_code = 'PENCAIRAN_PUMK' AND aktif AND deleted_at IS NULL`,
      [f.bumnId],
    );
    expect(Number(aktif[0]!.n)).toBe(1);

    // And the decision is evidence: who proposed, who decided, and the before.
    //
    // Read straight from `audit_log` rather than through `f.auditRows`, which
    // filters to the fixture's own six users: the approver here is a SEVENTH
    // account created in this file precisely because no fixture role but
    // ADMIN_PUSAT holds `konfigurasi.mapping`, so its rows are invisible to
    // that helper.
    const jejak = await f.db.query<{
      user_id: string;
      nilai_lama_json: unknown;
      nilai_baru_json: unknown;
      keterangan: string | null;
    }>(
      `SELECT user_id::text AS user_id, nilai_lama_json, nilai_baru_json, keterangan
         FROM audit_log
        WHERE aksi = 'jurnal.mapping.setujui' AND user_id = $1::uuid
        ORDER BY id DESC LIMIT 1`,
      [pemutusId],
    );
    expect(jejak.length).toBe(1);
    expect(JSON.stringify(jejak[0]!.nilai_lama_json)).toContain("1.1.01");
    expect(JSON.stringify(jejak[0]!.nilai_baru_json)).toContain("1.1.02");
    // The row names BOTH people, which is the whole point of the control.
    expect(jejak[0]!.keterangan).toContain(f.users.ADMIN_PUSAT.id);
    expect(jejak[0]!.keterangan).toContain(pemutusId);
  });

  test("a rejected proposal leaves the mapping exactly where it was", async () => {
    const { f, pengusul, pemutus, akunIdByKode } = await dunia();
    const usulan = await json<{ id: string }>(
      await f.request("/jurnal/mapping/usulan", {
        method: "POST",
        cookie: pengusul,
        body: {
          eventCode: "PENCAIRAN_PUMK",
          akunDebitId: akunIdByKode.get("1.1.03"),
          akunKreditId: akunIdByKode.get("1.1.02"),
          alasan: "Usulan yang akan ditolak oleh pemutus",
        },
      }),
    );
    const res = await f.request(`/jurnal/mapping/usulan/${usulan.id}/tolak`, {
      method: "POST",
      cookie: pemutus,
      body: { catatan: "Kas besar masih dipakai cabang" },
    });
    expect(res.status).toBe(200);
    expect((await json<{ status: string }>(res)).status).toBe("DITOLAK");

    const berlaku = await json<{ data: { eventCode: string; akunKreditKode: string | null }[] }>(
      await f.request("/jurnal/mapping", { cookie: pengusul }),
    );
    expect(berlaku.data.find((m) => m.eventCode === "PENCAIRAN_PUMK")!.akunKreditKode).toBe("1.1.01");
  });

  test("a decided proposal cannot be decided again", async () => {
    const { f, pengusul, pemutus, akunIdByKode } = await dunia();
    const usulan = await json<{ id: string }>(
      await f.request("/jurnal/mapping/usulan", {
        method: "POST",
        cookie: pengusul,
        body: {
          eventCode: "PENCAIRAN_PUMK",
          akunDebitId: akunIdByKode.get("1.1.03"),
          akunKreditId: akunIdByKode.get("1.1.02"),
          alasan: "Usulan yang diputus dua kali",
        },
      }),
    );
    expect(
      (
        await f.request(`/jurnal/mapping/usulan/${usulan.id}/tolak`, {
          method: "POST",
          cookie: pemutus,
          body: {},
        })
      ).status,
    ).toBe(200);
    const lagi = await f.request(`/jurnal/mapping/usulan/${usulan.id}/setujui`, {
      method: "POST",
      cookie: pemutus,
      body: {},
    });
    expect(lagi.status).toBe(409);
  });

  test("two open proposals for the same event are refused, so no approval can silently lose", async () => {
    const { f, pengusul, akunIdByKode } = await dunia();
    const body = {
      eventCode: "PENCAIRAN_PUMK",
      akunDebitId: akunIdByKode.get("1.1.03"),
      akunKreditId: akunIdByKode.get("1.1.02"),
      alasan: "Usulan pertama untuk event ini",
    };
    expect((await f.request("/jurnal/mapping/usulan", { method: "POST", cookie: pengusul, body })).status).toBe(201);
    const kedua = await f.request("/jurnal/mapping/usulan", {
      method: "POST",
      cookie: pengusul,
      body: { ...body, alasan: "Usulan kedua untuk event yang sama" },
    });
    expect(kedua.status).toBe(409);
  });

  test("the proposer may withdraw their own proposal, and nobody else may", async () => {
    const { f, pengusul, pemutus, akunIdByKode } = await dunia();
    const usulan = await json<{ id: string }>(
      await f.request("/jurnal/mapping/usulan", {
        method: "POST",
        cookie: pengusul,
        body: {
          eventCode: "PENCAIRAN_PUMK",
          akunDebitId: akunIdByKode.get("1.1.03"),
          akunKreditId: akunIdByKode.get("1.1.02"),
          alasan: "Usulan yang akan ditarik kembali",
        },
      }),
    );
    expect(
      (await f.request(`/jurnal/mapping/usulan/${usulan.id}/batal`, { method: "POST", cookie: pemutus, body: {} }))
        .status,
    ).toBe(403);
    const res = await f.request(`/jurnal/mapping/usulan/${usulan.id}/batal`, {
      method: "POST",
      cookie: pengusul,
      body: {},
    });
    expect(res.status).toBe(200);
    expect((await json<{ status: string }>(res)).status).toBe("DIBATALKAN");
  });
});

describe("what a proposal may not say", () => {
  test("an unknown event code is refused: the code set is code, only the accounts are data", async () => {
    const { f, pengusul, akunIdByKode } = await dunia();
    const res = await f.request("/jurnal/mapping/usulan", {
      method: "POST",
      cookie: pengusul,
      body: {
        eventCode: "PENCAIRAN_ENTAH_APA",
        akunDebitId: akunIdByKode.get("1.1.03"),
        akunKreditId: akunIdByKode.get("1.1.01"),
        alasan: "Event yang tidak dikenal mesin jurnal",
      },
    });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toMatch(/event/i);
  });

  test("a header account is refused before the foreign key sees it", async () => {
    const { f, pengusul, akunIdByKode } = await dunia();
    const res = await f.request("/jurnal/mapping/usulan", {
      method: "POST",
      cookie: pengusul,
      body: {
        eventCode: "PENCAIRAN_PUMK",
        akunDebitId: akunIdByKode.get("1"),
        akunKreditId: akunIdByKode.get("1.1.01"),
        alasan: "Mengarahkan pemetaan ke akun header",
      },
    });
    expect(res.status).toBe(400);
    const body = await json<{ error: string }>(res);
    expect(body.error).toMatch(/postable/i);
    expect(body.error).not.toContain("akun_postable_id_uq");
  });

  test("the same account on both legs is refused", async () => {
    const { f, pengusul, akunIdByKode } = await dunia();
    const res = await f.request("/jurnal/mapping/usulan", {
      method: "POST",
      cookie: pengusul,
      body: {
        eventCode: "PENCAIRAN_PUMK",
        akunDebitId: akunIdByKode.get("1.1.01"),
        akunKreditId: akunIdByKode.get("1.1.01"),
        alasan: "Debit dan kredit ke akun yang sama",
      },
    });
    expect(res.status).toBe(400);
  });

  test("a leg that is neither an account nor marked as coming from the payload is refused", async () => {
    const { f, pengusul, akunIdByKode } = await dunia();
    const res = await f.request("/jurnal/mapping/usulan", {
      method: "POST",
      cookie: pengusul,
      body: {
        eventCode: "PENCAIRAN_PUMK",
        akunDebitId: akunIdByKode.get("1.1.03"),
        akunKreditId: null,
        kreditDariPayload: false,
        alasan: "Kaki kredit kosong tanpa penanda dari payload",
      },
    });
    expect(res.status).toBe(400);
  });

  test("a reason shorter than a sentence is refused: the row carries no other explanation", async () => {
    const { f, pengusul, akunIdByKode } = await dunia();
    const res = await f.request("/jurnal/mapping/usulan", {
      method: "POST",
      cookie: pengusul,
      body: {
        eventCode: "PENCAIRAN_PUMK",
        akunDebitId: akunIdByKode.get("1.1.03"),
        akunKreditId: akunIdByKode.get("1.1.02"),
        alasan: "pindah",
      },
    });
    expect(res.status).toBe(400);
  });

  test("an account from another entity is not addressable", async () => {
    const { f, pengusul, akunIdByKode } = await dunia();
    const lain = await createFixture();
    const akunLain = await seedCoaInti(lain.db, lain.bumnId, lain.users.ADMIN_PUSAT.id);
    const res = await f.request("/jurnal/mapping/usulan", {
      method: "POST",
      cookie: pengusul,
      body: {
        eventCode: "PENCAIRAN_PUMK",
        akunDebitId: akunLain.get("1.1.03"),
        akunKreditId: akunIdByKode.get("1.1.01"),
        alasan: "Akun milik entitas lain sebagai kaki debit",
      },
    });
    expect(res.status).toBe(404);
  });
});
