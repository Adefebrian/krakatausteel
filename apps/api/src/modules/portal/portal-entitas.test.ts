// GET /portal/entitas, over the SAME app `createApp` builds for the server.
//
// WHY THE ROUTE EXISTS. `POST /portal/pengajuan` takes `kodeEntitas` (a
// `bumn.kode`) and nothing public could produce one, so the application form
// had to ask a member of the public to type a code off a leaflet. A mistyped
// code is a refused application the applicant cannot diagnose.
//
// WHAT THIS FILE PINS DOWN, and it is the security half rather than the
// feature half: the answer is TWO COLUMNS, live entities only, and there is
// nothing in the request an attacker can turn it into an enumeration surface
// with. The moment a later change adds a field, an id, or a filter, one of
// these fails.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createFixture, type Fixture } from "../../testing/harness";

interface BarisEntitas {
  kode: string;
  nama: string;
}

describe("portal publik: daftar entitas", () => {
  let f: Fixture;
  let kodeMati = "";

  async function ambil(path = "/portal/entitas"): Promise<Response> {
    return f.request(path, { method: "GET" });
  }

  beforeAll(async () => {
    f = await createFixture();
    // A second entity, switched OFF, so "live entities only" is a claim about
    // real rows rather than about an empty set.
    kodeMati = `MATI-${f.suffix}`;
    await f.db.query(
      `insert into bumn (kode, nama, aktif) values ($1, $2, false)`,
      [kodeMati, `Entitas Nonaktif ${f.suffix}`],
    );
  });

  afterAll(async () => {
    await f.db.query(`delete from bumn where kode = $1`, [kodeMati]);
    await f.tutup();
  });

  test("tanpa sesi sama sekali: 200, dan entitas fixture ini ada di dalamnya", async () => {
    const r = await ambil();
    expect(r.status).toBe(200);
    const body = (await r.json()) as { data: BarisEntitas[] };
    const kode = body.data.map((x) => x.kode);
    const bumn = await f.db.query<{ kode: string; nama: string }>(
      `select kode, nama from bumn where id = $1::uuid`,
      [f.bumnId],
    );
    expect(kode).toContain(bumn[0]!.kode);
    const baris = body.data.find((x) => x.kode === bumn[0]!.kode)!;
    expect(baris.nama).toBe(bumn[0]!.nama);
  });

  test("hanya dua kolom, dan tidak ada id di dalamnya", async () => {
    // The whole security argument of this route is "it reveals what a leaflet
    // reveals". A third key here is a decision about what an anonymous caller
    // may know, and it has to be made deliberately, not by a `select *`.
    const body = (await (await ambil()).json()) as { data: BarisEntitas[] };
    expect(body.data.length).toBeGreaterThan(0);
    for (const baris of body.data) {
      expect(Object.keys(baris).sort()).toEqual(["kode", "nama"]);
    }
    expect(JSON.stringify(body)).not.toContain(f.bumnId);
  });

  test("entitas nonaktif tidak muncul", async () => {
    const body = (await (await ambil()).json()) as { data: BarisEntitas[] };
    expect(body.data.map((x) => x.kode)).not.toContain(kodeMati);
  });

  test("entitas nonaktif juga tidak menerima pengajuan, jadi daftarnya tidak berbohong", async () => {
    // The list and the submit endpoint must describe the SAME set. Before this
    // change `entitasAktif` checked only `deleted_at`, so an entity switched
    // off in Organisasi kept accepting public applications while no list
    // advertised it.
    const r = await f.request("/portal/pengajuan", {
      method: "POST",
      body: {
        kodeEntitas: kodeMati,
        jenis: "PUMK",
        emailKontak: "uji@contoh.local",
        nik: "3201010101900001",
        formulir: {
          nama_lengkap: "Uji Nonaktif",
          nama_usaha: "Warung Uji",
          alamat: "Jl. Uji No. 1",
          jumlah_diajukan: "5000000.00",
          tenor_diajukan: 12,
          tujuan_penggunaan: "Tambahan modal kerja",
        },
      },
    });
    expect(r.status).toBe(404);
    expect((await r.json()).kodeDomain).toBe("ENTITAS_TIDAK_DITEMUKAN");
  });

  test("tidak ada parameter apa pun yang bisa dipakai menelusuri sesuatu", async () => {
    // No filter, no search, no cursor: an unknown query string changes nothing,
    // so there is no handle to enumerate BY. Also proves the route is not a
    // prefix for anything: `/portal/entitas/<id>` is the module's own 404.
    const polos = (await (await ambil()).json()) as { data: BarisEntitas[] };
    const dicoba = (await (await ambil("/portal/entitas?kode=X&q=a&cabang=1")).json()) as {
      data: BarisEntitas[];
    };
    expect(dicoba.data).toEqual(polos.data);

    const anak = await ambil(`/portal/entitas/${f.bumnId}`);
    expect(anak.status).toBe(404);
  });

  test("jawabannya boleh di-cache bersama, karena sama untuk semua orang", async () => {
    // And it is `public`, not `no-store`, precisely because there is nothing
    // caller-specific in it. The status check next door is `no-store` for the
    // opposite reason, and the contrast is the point.
    const r = await ambil();
    expect(r.headers.get("cache-control")).toBe("public, max-age=300");
  });
});
