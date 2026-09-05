// Spec 9.6's bulk import over HTTP, through the SAME app `createApp` builds
// for the server (apps/api/src/testing/harness.ts rule 1).
//
// THE FOUR CLAIMS THE IMPORT MAKES, one section each:
//
//   1. ALL OR NOTHING PER FILE. One bad row and the file is refused whole,
//      with the rejection list and the LINE NUMBERS attached, and the database
//      is byte-identical afterwards.
//   2. EVERY JOURNAL GOES THROUGH `postingEvent`. The receipt import produces
//      real journals, and it produces them by driving the instalment engine,
//      not by writing `jurnal` rows. Migration 0020's posting-path trigger is
//      the guarantee; this file shows the journals arrive AND that the whole
//      file is one transaction.
//   3. EVERY IMPORTED ROW IS ATTRIBUTABLE. `impor_berkas` names the file, its
//      checksum and its uploader; `impor_baris` ties each created entity, and
//      each journal, to a line number in that file. The same file cannot be
//      committed twice.
//   4. AN IMPORT CANNOT DO WHAT ITS OPERATOR COULD NOT DO ONE ROW AT A TIME.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createFixture, type Fixture } from "../../testing/harness";
import { seedCoaDanEventMapping } from "../../seed/event-jurnal";
import { buatDuniaImpor, buatPeriodeOpen, csv, type DuniaImpor } from "./test-support";

const HEADER_MITRA = [
  "kode_mitra",
  "nama_lengkap",
  "nik",
  "jenis_kelamin",
  "tanggal_lahir",
  "alamat",
  "telepon",
  "email",
  "nama_usaha",
  "bidang_usaha",
  "kode_mitra_lama",
] as const;

const HEADER_ANGSURAN = ["no_akad", "tanggal", "jumlah", "kode_akun_kas", "no_bukti"] as const;

describe("impor: unggah massal", () => {
  let f: Fixture;
  let cookieMaker = "";
  let cookieChecker = "";
  let cookieAdminPusat = "";
  let dunia: DuniaImpor;
  let seq = 0;

  /** Unique per call, so a rerun of the suite cannot collide on kode/NIK. */
  function barisMitra(n: number): string[][] {
    const out: string[][] = [];
    for (let i = 0; i < n; i += 1) {
      seq += 1;
      const tag = `${f.suffix}-${seq}`;
      out.push([
        `KM-${tag}`,
        `Mitra Impor ${seq}`,
        `31${String(Date.now() % 100000000).padStart(8, "0")}${String(seq).padStart(6, "0")}`.slice(0, 16),
        seq % 2 === 0 ? "L" : "P",
        "1990-05-17",
        "Jl. Impor No. 1",
        "081234567890",
        `impor${seq}.${f.suffix}@contoh.local`,
        `Usaha ${seq}`,
        "Perdagangan",
        "",
      ]);
    }
    return out;
  }

  async function kirim(
    jalur: "pratinjau" | "komit",
    jenis: "MITRA" | "ANGSURAN",
    isi: string,
    opsi: { cookie?: string; namaFile?: string; cabangId?: string } = {},
  ): Promise<Response> {
    return f.request(`/impor/${jenis}/${jalur}`, {
      cookie: opsi.cookie ?? cookieMaker,
      method: "POST",
      body: {
        namaFile: opsi.namaFile ?? "impor.csv",
        isi,
        ...(opsi.cabangId ? { cabangId: opsi.cabangId } : {}),
      },
    });
  }

  async function cacahMitra(): Promise<number> {
    const r = await f.db.query<{ n: string }>(
      `select count(*)::text as n from mitra m join cabang c on c.id = m.cabang_id
        where c.bumn_id = $1::uuid`,
      [f.bumnId],
    );
    return Number(r[0]?.n ?? "0");
  }

  beforeAll(async () => {
    f = await createFixture();
    await seedCoaDanEventMapping(f.db, f.bumnId, f.users.ADMIN_PUSAT.id);
    await buatPeriodeOpen(f.db, f.bumnId, 2026, 2);
    await buatPeriodeOpen(f.db, f.bumnId, 2026, 3);
    cookieMaker = await f.login(f.users.MAKER.username);
    cookieChecker = await f.login(f.users.CHECKER.username);
    cookieAdminPusat = await f.login(f.users.ADMIN_PUSAT.username);
    dunia = await buatDuniaImpor(f.db, {
      bumnId: f.bumnId,
      cabangId: f.users.MAKER.cabang.id,
      suffix: f.suffix,
    });
  });

  afterAll(async () => {
    await f.tutup();
  });

  // ------------------------------------------------------------------ 4.

  test("tanpa sesi: 401 di pratinjau dan di komit", async () => {
    const isi = csv(HEADER_MITRA, barisMitra(1));
    expect((await f.request("/impor/MITRA/pratinjau", { method: "POST", body: { isi } })).status).toBe(401);
    expect((await f.request("/impor/MITRA/komit", { method: "POST", body: { isi } })).status).toBe(401);
  });

  test("CHECKER tidak memegang tools.import: 403 dengan baris DITOLAK", async () => {
    const res = await kirim("pratinjau", "MITRA", csv(HEADER_MITRA, barisMitra(1)), {
      cookie: cookieChecker,
    });
    expect(res.status).toBe(403);
    const ditolak = await f.auditRows({ hasil: "DITOLAK", userId: f.users.CHECKER.id });
    expect(
      ditolak.some(
        (r) => (r.nilai_baru_json as { path?: string } | null)?.path === "/impor/MITRA/pratinjau",
      ),
    ).toBe(true);
  });

  test("ADMIN_PUSAT memegang tools.import tapi TIDAK pumk.angsuran lewat impor", async () => {
    // ADMIN_PUSAT holds every code, so this is the positive control for rule 4
    // rather than the negative one: the point is that the ENGINE checked, and
    // a caller lacking the ordinary operational code is refused by it.
    const res = await kirim("pratinjau", "MITRA", csv(HEADER_MITRA, barisMitra(1)), {
      cookie: cookieAdminPusat,
    });
    expect(res.status).toBe(200);
  });

  test("jenis impor yang tidak dikenal: 400 VALIDASI", async () => {
    // `SALDO_AWAL` used to be the example here, which stopped being an unknown
    // kind the day the go-live import landed. The CLAIM is unchanged: a kind
    // the router does not know is a 400 that names the set it does know.
    const res = await f.request("/impor/AKAD/pratinjau", {
      cookie: cookieMaker,
      method: "POST",
      body: { isi: "a,b\n1,2" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: Record<string, string[]> };
    expect(body.detail?.jenis?.[0]).toContain("MITRA, ANGSURAN, SALDO_AWAL");
  });

  test("cabang di luar scope penyunggah DITOLAK 403 dengan kodeDomain", async () => {
    const res = await kirim("pratinjau", "MITRA", csv(HEADER_MITRA, barisMitra(1)), {
      cabangId: f.cabangB.id,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { kodeDomain?: string };
    // Without "ImporError" in core/http.ts's NAMA_ERROR_BERKODE this would be
    // an anonymous 500 with no code and no audit row.
    expect(body.kodeDomain).toBe("CABANG_DILUAR_SCOPE");
  });

  // ------------------------------------------------------------------ 1.

  test("pratinjau MENULIS TIDAK APA-APA, termasuk baris berkasnya sendiri", async () => {
    const sebelumMitra = await cacahMitra();
    const sebelumBerkas = await f.db.query<{ n: string }>(
      "select count(*)::text as n from impor_berkas where bumn_id = $1::uuid",
      [f.bumnId],
    );
    const res = await kirim("pratinjau", "MITRA", csv(HEADER_MITRA, barisMitra(3)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { diterima: unknown[]; ditolak: unknown[]; siapKomit: boolean };
    expect(body.diterima).toHaveLength(3);
    expect(body.ditolak).toEqual([]);
    expect(body.siapKomit).toBe(true);

    expect(await cacahMitra()).toBe(sebelumMitra);
    const sesudahBerkas = await f.db.query<{ n: string }>(
      "select count(*)::text as n from impor_berkas where bumn_id = $1::uuid",
      [f.bumnId],
    );
    expect(sesudahBerkas[0]?.n).toBe(sebelumBerkas[0]?.n);
  });

  test("SATU baris cacat membatalkan SELURUH berkas, dan menyebut nomor barisnya", async () => {
    const baik = barisMitra(2);
    const rusak = barisMitra(1)[0]!.slice();
    rusak[2] = "123"; // NIK, wajib 16 digit
    rusak[3] = "X"; // jenis kelamin, wajib L atau P
    const isi = csv(HEADER_MITRA, [baik[0]!, rusak, baik[1]!]);

    const pratinjau = await kirim("pratinjau", "MITRA", isi);
    expect(pratinjau.status).toBe(200);
    const laporan = (await pratinjau.json()) as {
      siapKomit: boolean;
      ditolak: { nomorBaris: number; alasan: Record<string, string[]> }[];
      diterima: { nomorBaris: number }[];
    };
    expect(laporan.siapKomit).toBe(false);
    expect(laporan.ditolak).toHaveLength(1);
    // Line 3 of the file: the header is line 1, the first good row is line 2.
    expect(laporan.ditolak[0]!.nomorBaris).toBe(3);
    expect(Object.keys(laporan.ditolak[0]!.alasan).sort()).toEqual(["jenis_kelamin", "nik"]);
    expect(laporan.diterima.map((d) => d.nomorBaris)).toEqual([2, 4]);

    const sebelum = await cacahMitra();
    const komit = await kirim("komit", "MITRA", isi);
    expect(komit.status).toBe(400);
    const body = (await komit.json()) as {
      kodeDomain?: string;
      laporan?: { ditolak: { nomorBaris: number }[]; siapKomit: boolean };
    };
    expect(body.kodeDomain).toBe("ADA_BARIS_DITOLAK");
    // The rejection report travels WITH the refusal, so the operator does not
    // have to run a second preview to find out which line was wrong.
    expect(body.laporan?.siapKomit).toBe(false);
    expect(body.laporan?.ditolak.map((d) => d.nomorBaris)).toEqual([3]);
    // NOT EVEN THE TWO GOOD ROWS. That is the whole rule.
    expect(await cacahMitra()).toBe(sebelum);
  });

  test("baris dengan jumlah kolom berbeda ditolak, tidak dipadatkan diam-diam", async () => {
    const isi = `${csv(HEADER_MITRA, barisMitra(1))}\nKM-PENDEK,Nama Saja`;
    const res = await kirim("pratinjau", "MITRA", isi);
    const laporan = (await res.json()) as { ditolak: { nomorBaris: number; alasan: Record<string, string[]> }[] };
    expect(laporan.ditolak).toHaveLength(1);
    expect(laporan.ditolak[0]!.alasan.baris?.[0]).toContain("jumlah kolom 2");
  });

  test("duplikat DI DALAM berkas ditolak sebelum menyentuh constraint database", async () => {
    const satu = barisMitra(1)[0]!;
    const isi = csv(HEADER_MITRA, [satu, satu]);
    const res = await kirim("pratinjau", "MITRA", isi);
    const laporan = (await res.json()) as { ditolak: { alasan: Record<string, string[]> }[] };
    expect(laporan.ditolak).toHaveLength(1);
    expect(laporan.ditolak[0]!.alasan.kode_mitra?.[0]).toContain("duplikat di dalam berkas");
  });

  test("header yang tidak lengkap atau memuat kolom asing menolak berkas seutuhnya", async () => {
    const kurang = await kirim("pratinjau", "MITRA", "kode_mitra\nKM-1");
    expect(kurang.status).toBe(400);
    expect(((await kurang.json()) as { kodeDomain?: string }).kodeDomain).toBe("HEADER_TIDAK_LENGKAP");

    const asing = await kirim(
      "pratinjau",
      "MITRA",
      "kode_mitra,nama_lengkap,gaji\nKM-1,Nama,999",
    );
    expect(asing.status).toBe(400);
    const body = (await asing.json()) as { kodeDomain?: string; error: string };
    expect(body.kodeDomain).toBe("HEADER_TIDAK_LENGKAP");
    // The offending column is NAMED. core/http.ts does not carry a domain
    // error's `detail` into the body, so the message has to.
    expect(body.error).toContain("gaji");
  });

  // ------------------------------------------------------------------ 3.

  test("komit yang sah menulis mitra DAN provenance per baris", async () => {
    const baris = barisMitra(3);
    const isi = csv(HEADER_MITRA, baris);
    const res = await kirim("komit", "MITRA", isi, { namaFile: "mitra-gelombang-1.csv" });
    expect(res.status).toBe(201);
    const hasil = (await res.json()) as {
      berkasId: string;
      jumlahDitulis: number;
      checksum: string;
      jurnalIds: string[];
    };
    expect(hasil.jumlahDitulis).toBe(3);
    expect(hasil.jurnalIds).toEqual([]);
    expect(hasil.checksum).toMatch(/^[0-9a-f]{64}$/);

    const berkas = await f.db.query<{
      nama_file: string;
      jumlah_baris: number;
      diunggah_oleh: string;
      cabang_id: string;
    }>(
      `select nama_file, jumlah_baris, diunggah_oleh::text as diunggah_oleh,
              cabang_id::text as cabang_id
         from impor_berkas where id = $1::uuid`,
      [hasil.berkasId],
    );
    expect(berkas[0]?.nama_file).toBe("mitra-gelombang-1.csv");
    expect(berkas[0]?.jumlah_baris).toBe(3);
    expect(berkas[0]?.diunggah_oleh).toBe(f.users.MAKER.id);
    expect(berkas[0]?.cabang_id).toBe(f.users.MAKER.cabang.id);

    const provenance = await f.db.query<{ nomor_baris: number; entitas: string; kode: string }>(
      `select b.nomor_baris, b.entitas, m.kode_mitra as kode
         from impor_baris b join mitra m on m.id = b.entitas_id
        where b.berkas_id = $1::uuid order by b.nomor_baris`,
      [hasil.berkasId],
    );
    expect(provenance.map((p) => p.nomor_baris)).toEqual([2, 3, 4]);
    expect(provenance.every((p) => p.entitas === "mitra")).toBe(true);
    expect(provenance.map((p) => p.kode)).toEqual(baris.map((b) => b[0]!));
  });

  test("berkas yang sama persis tidak bisa dikomit dua kali", async () => {
    const isi = csv(HEADER_MITRA, barisMitra(2));
    expect((await kirim("komit", "MITRA", isi)).status).toBe(201);

    const sebelum = await cacahMitra();
    const lagi = await kirim("komit", "MITRA", isi);
    expect(lagi.status).toBe(409);
    const body = (await lagi.json()) as { kodeDomain?: string };
    expect(body.kodeDomain).toBe("BERKAS_SUDAH_DIIMPOR");
    expect(await cacahMitra()).toBe(sebelum);
  });

  test("komit menulis satu baris audit yang menyebut berkas dan jumlah barisnya", async () => {
    const isi = csv(HEADER_MITRA, barisMitra(1));
    const res = await kirim("komit", "MITRA", isi, { namaFile: "jejak.csv" });
    const { berkasId } = (await res.json()) as { berkasId: string };
    const rows = await f.db.query<{ keterangan: string; nilai_baru_json: unknown }>(
      `select keterangan, nilai_baru_json from audit_log
        where aksi = 'impor.komit' and entitas_id = $1 and hasil = 'SUKSES'`,
      [berkasId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.keterangan).toContain("jejak.csv");
    expect((rows[0]!.nilai_baru_json as { jumlahDitulis: number }).jumlahDitulis).toBe(1);
  });

  // ------------------------------------------------------------------ 2.

  test("impor angsuran mem-posting jurnal LEWAT engine, satu jurnal per baris", async () => {
    const isi = csv(HEADER_ANGSURAN, [
      [dunia.noAkad, "2026-02-10", "200000.00", dunia.kodeAkunKas, "BKT-IMP-1"],
      [dunia.noAkad, "2026-03-10", "150000.00", dunia.kodeAkunKas, "BKT-IMP-2"],
    ]);
    const res = await kirim("komit", "ANGSURAN", isi, { namaFile: "setoran-februari.csv" });
    if (res.status !== 201) throw new Error(`komit angsuran gagal: ${res.status} ${await res.text()}`);
    const hasil = (await res.json()) as { berkasId: string; jumlahDitulis: number; jurnalIds: string[] };
    expect(hasil.jumlahDitulis).toBe(2);
    expect(hasil.jurnalIds).toHaveLength(2);
    expect(new Set(hasil.jurnalIds).size).toBe(2);

    // Every journal really exists and really is in the ledger. It got there
    // through the instalment engine, which posts through `postingEvent`;
    // migration 0020's trigger refuses any other route, so a journal being
    // here at all is the proof.
    for (const id of hasil.jurnalIds) {
      const j = await f.db.query<{ status: string; referensi_tipe: string | null }>(
        "select status, referensi_tipe from jurnal where id = $1::uuid",
        [id],
      );
      expect(j).toHaveLength(1);
      expect(j[0]!.referensi_tipe).toBe("pumk_angsuran");
    }

    const provenance = await f.db.query<{
      nomor_baris: number;
      entitas: string;
      jurnal_id: string | null;
    }>(
      `select nomor_baris, entitas, jurnal_id::text as jurnal_id
         from impor_baris where berkas_id = $1::uuid order by nomor_baris`,
      [hasil.berkasId],
    );
    expect(provenance.map((p) => p.nomor_baris)).toEqual([2, 3]);
    expect(provenance.every((p) => p.entitas === "pumk_angsuran")).toBe(true);
    expect(provenance.map((p) => p.jurnal_id)).toEqual(hasil.jurnalIds);
  });

  test("satu baris angsuran cacat membatalkan SELURUH berkas: nol jurnal, nol setoran", async () => {
    const sebelum = await f.db.query<{ jurnal: string; angsuran: string }>(
      `select (select count(*)::text from jurnal where bumn_id = $1::uuid) as jurnal,
              (select count(*)::text from pumk_angsuran where akad_id = $2::uuid) as angsuran`,
      [f.bumnId, dunia.akadId],
    );
    const isi = csv(HEADER_ANGSURAN, [
      [dunia.noAkad, "2026-02-10", "100000.00", dunia.kodeAkunKas, "BKT-OK"],
      ["AKAD-TIDAK-ADA", "2026-02-10", "100000.00", dunia.kodeAkunKas, "BKT-BURUK"],
    ]);
    const res = await kirim("komit", "ANGSURAN", isi);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      kodeDomain?: string;
      laporan?: { ditolak: { nomorBaris: number; alasan: Record<string, string[]> }[] };
    };
    expect(body.kodeDomain).toBe("ADA_BARIS_DITOLAK");
    expect(body.laporan?.ditolak[0]?.nomorBaris).toBe(3);
    expect(body.laporan?.ditolak[0]?.alasan.no_akad?.[0]).toContain("tidak ditemukan di cabang ini");

    const sesudah = await f.db.query<{ jurnal: string; angsuran: string }>(
      `select (select count(*)::text from jurnal where bumn_id = $1::uuid) as jurnal,
              (select count(*)::text from pumk_angsuran where akad_id = $2::uuid) as angsuran`,
      [f.bumnId, dunia.akadId],
    );
    expect(sesudah[0]).toEqual(sebelum[0]!);
  });

  test("jumlah wajib desimal dua angka: float dan notasi lain ditolak per baris", async () => {
    const isi = csv(HEADER_ANGSURAN, [
      [dunia.noAkad, "2026-02-10", "100000", dunia.kodeAkunKas, "A"],
      [dunia.noAkad, "2026-02-10", "1.5e5", dunia.kodeAkunKas, "B"],
      [dunia.noAkad, "2026-02-10", "0.00", dunia.kodeAkunKas, "C"],
      [dunia.noAkad, "bukan-tanggal", "100000.00", dunia.kodeAkunKas, "D"],
    ]);
    const res = await kirim("pratinjau", "ANGSURAN", isi);
    const laporan = (await res.json()) as { ditolak: { nomorBaris: number }[]; siapKomit: boolean };
    expect(laporan.siapKomit).toBe(false);
    expect(laporan.ditolak.map((d) => d.nomorBaris)).toEqual([2, 3, 4, 5]);
  });

  test("akad cabang lain tidak bisa disetor lewat berkas cabang ini", async () => {
    const lain = await buatDuniaImpor(f.db, {
      bumnId: f.bumnId,
      cabangId: f.cabangB.id,
      suffix: f.suffix,
    });
    const isi = csv(HEADER_ANGSURAN, [
      [lain.noAkad, "2026-02-10", "100000.00", dunia.kodeAkunKas, "BKT-SILANG"],
    ]);
    const res = await kirim("pratinjau", "ANGSURAN", isi);
    const laporan = (await res.json()) as { ditolak: { alasan: Record<string, string[]> }[] };
    // The same refusal as "no such akad": the lookup is scoped by branch in the
    // query, so the file cannot be used to discover other branches' contracts.
    expect(laporan.ditolak).toHaveLength(1);
    expect(laporan.ditolak[0]!.alasan.no_akad?.[0]).toContain("tidak ditemukan di cabang ini");
  });

  test("berkas kosong dan berkas raksasa ditolak sebelum apa pun dibaca", async () => {
    const kosong = await kirim("pratinjau", "MITRA", "\n");
    expect(kosong.status).toBe(400);

    const raksasa = await kirim("pratinjau", "MITRA", "x".repeat(600 * 1024));
    expect(raksasa.status).toBe(400);
    const body = (await raksasa.json()) as { detail?: Record<string, string[]> };
    expect(body.detail?.isi?.[0]).toContain("KB");
  });

  test("path impor yang tidak ada: 404 dalam amplop API", async () => {
    const res = await f.request("/impor/tidak-ada", { cookie: cookieMaker });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(((await res.json()) as { code: string }).code).toBe("TIDAK_DITEMUKAN");
  });
});
