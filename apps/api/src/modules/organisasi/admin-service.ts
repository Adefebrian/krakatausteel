// The WRITE half of the organisation module: users, branches, employees.
//
// Kept in its own file next to the read service rather than appended to it,
// because the two have different shapes and different risks. The read service
// is the reference implementation of branch scoping (see ./service.ts); this
// one is where authority is handed out, and it deserves to be read on its own.
//
// FOUR RULES, EACH OF WHICH IS A TEST
//
// 1. NOTHING IS DELETED. Every entity here is referenced by posted history, so
//    the only removal is `aktif = false`. The reasoning per entity is at the
//    top of ./repo.ts and in each method below.
// 2. A ROLE GRANT CANNOT WIDEN AUTHORITY. ./peran.ts holds the rule; this file
//    only applies it, once, on the single path that writes `user_role`.
// 3. NOBODY EDITS THEIR OWN AUTHORITY. Not their roles, not their own active
//    flag. It is refused for every role including Admin Pusat, because the
//    control is "two people were involved", and an exception for the most
//    privileged account is an exception exactly where it matters most.
// 4. A HANDED-OVER PASSWORD IS A ONE-TIME PASSWORD. Generated here, shown once
//    in the response, stored only as an argon2id hash, never written to
//    `audit_log`, and the account it opens carries `harus_ganti_sandi` so it
//    can do nothing until its owner replaces it. This is the scheme
//    `modules/mitra` already uses for a borrower account; it is deliberately
//    not a second one.
import { badRequest, conflict, forbidden, notFound } from "../../core/http";
import { assertCabangAllowed, allowedCabangIds } from "../../core/principal";
import { assertBolehMemberiPeran, isRoleCode, peranUntukPemberi, type PeranTersedia } from "./peran";
import type { AuditPort, DbPort, Principal, QueryRunner } from "./ports";
import {
  createOrganisasiAdminRepo,
  createOrganisasiRepo,
  type CabangRow,
  type KaryawanRow,
  type OrganisasiAdminRepo,
  type OrganisasiRepo,
  type PenggunaRow,
  type PeranGrant,
} from "./repo";

/**
 * Alphabet for a generated one-time password: unambiguous in print and safe to
 * read aloud, which is how an administrator actually hands one over. Copied in
 * spirit from modules/mitra, which explains the same choice.
 */
const ALFABET_SANDI = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PANJANG_SANDI_SEMENTARA = 16;

export function buatSandiSementara(panjang = PANJANG_SANDI_SEMENTARA): string {
  const bytes = new Uint8Array(panjang);
  crypto.getRandomValues(bytes);
  let keluar = "";
  for (const b of bytes) keluar += ALFABET_SANDI[b % ALFABET_SANDI.length];
  return keluar;
}

const POLA_USERNAME = /^[a-z0-9][a-z0-9._-]{2,49}$/;
const POLA_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const POLA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLA_KODE_CABANG = /^[A-Z0-9][A-Z0-9._-]{0,9}$/;

export interface PenggunaTampil {
  id: string;
  cabangId: string;
  cabangKode: string;
  cabangNama: string;
  nip: string | null;
  nama: string;
  email: string;
  username: string;
  aktif: boolean;
  harusGantiSandi: boolean;
  lastLoginAt: string | null;
  sandiDiubahAt: string | null;
  version: number;
  peran: { kode: string; scopeCabangId: string | null }[];
}

export interface HasilSandiSementara {
  id: string;
  username: string;
  /** Shown ONCE. Not stored in the clear and not in the audit trail. */
  sandiSementara: string;
}

export interface BuatPenggunaBody {
  username: string;
  nama: string;
  email: string;
  nip?: string | null;
  cabangId: string;
  peran: { kode: string; scopeCabangId?: string | null }[];
}

export interface UbahPenggunaBody {
  nama?: string | null;
  email?: string | null;
  nip?: string | null;
  cabangId?: string | null;
  version?: number | null;
}

export interface OrganisasiAdminService {
  peranTersedia(principal: Principal): PeranTersedia[];
  listPengguna(principal: Principal): Promise<PenggunaTampil[]>;
  getPengguna(principal: Principal, id: string): Promise<PenggunaTampil>;
  buatPengguna(
    principal: Principal,
    body: BuatPenggunaBody,
  ): Promise<PenggunaTampil & HasilSandiSementara>;
  ubahPengguna(principal: Principal, id: string, body: UbahPenggunaBody): Promise<PenggunaTampil>;
  gantiPeran(
    principal: Principal,
    id: string,
    peran: { kode: string; scopeCabangId?: string | null }[],
  ): Promise<PenggunaTampil>;
  setAktifPengguna(
    principal: Principal,
    id: string,
    aktif: boolean,
    alasan: string | null,
  ): Promise<PenggunaTampil>;
  resetSandi(principal: Principal, id: string): Promise<HasilSandiSementara>;

  buatCabang(
    principal: Principal,
    body: { kode: string; nama: string; alamat?: string | null; kotaId?: string | null; isPusat?: boolean },
  ): Promise<CabangRow>;
  ubahCabang(
    principal: Principal,
    id: string,
    body: { nama?: string | null; alamat?: string | null; kotaId?: string | null; version?: number | null },
  ): Promise<CabangRow>;
  setAktifCabang(principal: Principal, id: string, aktif: boolean): Promise<CabangRow>;

  buatKaryawan(
    principal: Principal,
    body: { cabangId: string; nama: string; nip?: string | null; jabatan?: string | null; unit?: string | null },
  ): Promise<KaryawanRow>;
  ubahKaryawan(
    principal: Principal,
    id: string,
    body: {
      nama?: string | null;
      nip?: string | null;
      jabatan?: string | null;
      unit?: string | null;
      cabangId?: string | null;
      version?: number | null;
    },
  ): Promise<KaryawanRow>;
  setAktifKaryawan(principal: Principal, id: string, aktif: boolean): Promise<KaryawanRow>;
}

export interface OrganisasiAdminDeps {
  db: DbPort;
  audit: AuditPort;
  repo?: OrganisasiRepo;
  adminRepo?: OrganisasiAdminRepo;
  /** argon2id parameters. Lowered by the test harness only. */
  passwordOptions?: { memoryCost?: number; timeCost?: number };
}

function tampil(row: PenggunaRow): PenggunaTampil {
  return {
    id: row.id,
    cabangId: row.cabang_id,
    cabangKode: row.cabang_kode,
    cabangNama: row.cabang_nama,
    nip: row.nip,
    nama: row.nama,
    email: row.email,
    username: row.username,
    aktif: row.aktif,
    harusGantiSandi: row.harus_ganti_sandi,
    lastLoginAt: row.last_login_at,
    sandiDiubahAt: row.sandi_diubah_at,
    version: row.version,
    peran: (row.peran ?? []).map((entri) => {
      const [kode, scope] = entri.split("@");
      return { kode: kode ?? entri, scopeCabangId: scope ?? null };
    }),
  };
}

/** Trims to null so an empty string never becomes a stored empty value. */
function teks(nilai: unknown, maks: number): string | null {
  if (typeof nilai !== "string") return null;
  const bersih = nilai.trim();
  return bersih.length === 0 ? null : bersih.slice(0, maks);
}

export function createOrganisasiAdminService({
  db,
  audit,
  repo = createOrganisasiRepo(),
  adminRepo = createOrganisasiAdminRepo(),
  passwordOptions = {},
}: OrganisasiAdminDeps): OrganisasiAdminService {
  const argon = { algorithm: "argon2id" as const, ...passwordOptions };

  const scope = (principal: Principal): string[] | null => {
    const ids = allowedCabangIds(principal);
    return ids.length === 0 ? null : ids;
  };

  /** Loads a branch pinned to the caller's entity, or 404. Never leaks across. */
  async function cabangDalamEntitas(
    runner: QueryRunner,
    principal: Principal,
    cabangId: string,
  ): Promise<CabangRow> {
    if (!POLA_UUID.test(cabangId)) throw badRequest("Format identitas cabang tidak valid");
    const row = await repo.findCabangById(runner, cabangId);
    if (!row || row.bumn_id !== principal.bumnId) throw notFound("Cabang tidak ditemukan");
    return row;
  }

  /** Loads a user pinned to the caller's entity AND branch scope, or throws. */
  async function penggunaTerjangkau(
    runner: QueryRunner,
    principal: Principal,
    id: string,
  ): Promise<PenggunaRow> {
    if (!POLA_UUID.test(id)) throw badRequest("Format identitas pengguna tidak valid");
    const row = await adminRepo.findPenggunaById(runner, id);
    if (!row || row.bumn_id !== principal.bumnId) throw notFound("Pengguna tidak ditemukan");
    assertCabangAllowed(principal, row.cabang_id);
    return row;
  }

  /**
   * Mirrors the unique indexes so a duplicate is a sentence naming the field
   * rather than a constraint name. The indexes remain the guarantee: this is a
   * read-then-write and therefore racy, and the database is the serialisation
   * point (the same split modules/auth/segregation.ts documents).
   */
  async function assertKredensialBebas(
    runner: QueryRunner,
    input: { username: string | null; email: string | null; kecualiId: string | null },
  ): Promise<void> {
    const dipakai = await adminRepo.kredensialDipakai(runner, input);
    if (dipakai.username) throw conflict(`Nama pengguna "${input.username}" sudah dipakai akun lain`);
    if (dipakai.email) throw conflict(`Alamat surel "${input.email}" sudah dipakai akun lain`);
  }

  /**
   * Validates and authorises a complete role set. One place, called by both
   * create and re-grant, so there is no path that writes `user_role` without
   * passing here.
   */
  async function periksaPeran(
    runner: QueryRunner,
    principal: Principal,
    diminta: { kode: string; scopeCabangId?: string | null }[],
  ): Promise<PeranGrant[]> {
    if (!Array.isArray(diminta) || diminta.length === 0) {
      throw badRequest("Pengguna harus punya sekurang-kurangnya satu peran", {
        peran: ["wajib diisi, minimal satu peran"],
      });
    }
    const keluar: PeranGrant[] = [];
    const terlihat = new Set<string>();
    for (const item of diminta) {
      const kode = typeof item?.kode === "string" ? item.kode.trim().toUpperCase() : "";
      if (!isRoleCode(kode)) {
        throw badRequest(`Peran "${kode}" tidak dikenal`, { peran: [`peran "${kode}" tidak dikenal`] });
      }
      if (terlihat.has(kode)) {
        throw badRequest(`Peran ${kode} disebut dua kali`, { peran: ["peran tidak boleh berulang"] });
      }
      terlihat.add(kode);
      assertBolehMemberiPeran(kode, principal.permissions, principal.lintasCabang);

      let scopeCabangId: string | null = null;
      const scopeMentah = item.scopeCabangId;
      if (typeof scopeMentah === "string" && scopeMentah.length > 0) {
        // A cross-branch grant is still bounded by the granter's own scope: an
        // Admin Cabang cannot hand somebody a foothold in a branch it cannot
        // reach itself.
        const cabang = await cabangDalamEntitas(runner, principal, scopeMentah);
        assertCabangAllowed(principal, cabang.id);
        scopeCabangId = cabang.id;
      }
      keluar.push({ kode, scopeCabangId });
    }
    // Every code is in ROLE_CODES, but the DATABASE is what must hold the row:
    // a database seeded without one of them would otherwise silently grant
    // fewer roles than the request asked for.
    const ids = await adminRepo.roleIdByKode(runner, keluar.map((p) => p.kode));
    const hilang = keluar.filter((p) => !ids.has(p.kode)).map((p) => p.kode);
    if (hilang.length > 0) {
      throw conflict(
        `Peran ${hilang.join(", ")} belum ada di katalog peran basis data. Jalankan seed RBAC.`,
      );
    }
    return keluar;
  }

  return {
    peranTersedia(principal) {
      return peranUntukPemberi(principal.permissions, principal.lintasCabang);
    },

    async listPengguna(principal) {
      const rows = await adminRepo.listPengguna(db, principal.bumnId, scope(principal));
      return rows.map(tampil);
    },

    async getPengguna(principal, id) {
      return tampil(await penggunaTerjangkau(db, principal, id));
    },

    async buatPengguna(principal, body) {
      const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const nama = teks(body.nama, 200);
      const galat: Record<string, string[]> = {};
      if (!POLA_USERNAME.test(username)) {
        galat.username = ["3 sampai 50 karakter, huruf kecil, angka, titik, garis bawah atau strip"];
      }
      if (!POLA_EMAIL.test(email) || email.length > 200) galat.email = ["alamat surel tidak valid"];
      if (!nama) galat.nama = ["wajib diisi"];
      if (typeof body.cabangId !== "string" || !POLA_UUID.test(body.cabangId)) {
        galat.cabangId = ["wajib berupa UUID cabang"];
      }
      if (Object.keys(galat).length > 0) throw badRequest("Data pengguna belum valid", galat);

      const sandiSementara = buatSandiSementara();
      const passwordHash = await Bun.password.hash(sandiSementara, argon);

      const hasil = await db.transaction(async (tx) => {
        const cabang = await cabangDalamEntitas(tx, principal, body.cabangId);
        // The branch decides, and the branch comes from the ROW, never from the
        // request: this is spec 16 scenario 24 applied to account creation.
        assertCabangAllowed(principal, cabang.id);
        if (!cabang.aktif) {
          throw conflict("Cabang ini sudah tidak aktif, jadi tidak bisa menerima pengguna baru");
        }
        const peran = await periksaPeran(tx, principal, body.peran ?? []);
        await assertKredensialBebas(tx, { username, email, kecualiId: null });

        const row = await adminRepo.insertPengguna(tx, {
          cabangId: cabang.id,
          nip: teks(body.nip, 50),
          nama: nama!,
          email,
          username,
          passwordHash,
          userId: principal.userId,
        });
        await adminRepo.gantiPeran(tx, {
          userId: row.id,
          peran,
          olehUserId: principal.userId,
        });

        await audit.record(
          {
            userId: principal.userId,
            aksi: "organisasi.pengguna.buat",
            entitas: "app_user",
            entitasId: row.id,
            // THE PASSWORD IS NOT HERE, and must never be: `audit_log` is
            // readable by every holder of `audit.view` and this is a live
            // credential for the length of one handover.
            nilaiBaru: {
              username: row.username,
              nama: row.nama,
              email: row.email,
              cabangId: row.cabang_id,
              peran: peran.map((p) => p.kode + (p.scopeCabangId ? `@${p.scopeCabangId}` : "")),
            },
            hasil: "SUKSES",
            keterangan: "akun pengguna dibuat dengan sandi sementara sekali pakai",
          },
          tx,
        );

        const lengkap = await adminRepo.findPenggunaById(tx, row.id);
        return tampil(lengkap ?? row);
      });

      return { ...hasil, sandiSementara };
    },

    async ubahPengguna(principal, id, body) {
      return db.transaction(async (tx) => {
        const sebelum = await penggunaTerjangkau(tx, principal, id);
        let cabangId: string | null = null;
        if (typeof body.cabangId === "string" && body.cabangId.length > 0) {
          const cabang = await cabangDalamEntitas(tx, principal, body.cabangId);
          // Moving a user between branches is a scope change, so BOTH the
          // branch they leave and the branch they arrive in must be inside the
          // caller's own scope. The first was already checked by
          // `penggunaTerjangkau`; this is the second.
          assertCabangAllowed(principal, cabang.id);
          cabangId = cabang.id;
        }
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : null;
        if (email !== null && (!POLA_EMAIL.test(email) || email.length > 200)) {
          throw badRequest("Alamat surel tidak valid", { email: ["alamat surel tidak valid"] });
        }
        await assertKredensialBebas(tx, { username: null, email, kecualiId: id });
        const sesudah = await adminRepo.updatePengguna(tx, {
          id,
          nama: teks(body.nama, 200),
          email,
          nip: teks(body.nip, 50),
          cabangId,
          userId: principal.userId,
          version: typeof body.version === "number" ? body.version : null,
        });
        if (!sesudah) {
          throw conflict(
            "Data pengguna sudah berubah sejak Anda membukanya. Muat ulang lalu ulangi perubahan.",
          );
        }
        await audit.record(
          {
            userId: principal.userId,
            aksi: "organisasi.pengguna.ubah",
            entitas: "app_user",
            entitasId: id,
            nilaiLama: { nama: sebelum.nama, email: sebelum.email, nip: sebelum.nip, cabangId: sebelum.cabang_id },
            nilaiBaru: { nama: sesudah.nama, email: sesudah.email, nip: sesudah.nip, cabangId: sesudah.cabang_id },
            hasil: "SUKSES",
            keterangan: "profil pengguna diubah",
          },
          tx,
        );
        return tampil(sesudah);
      });
    },

    async gantiPeran(principal, id, peranDiminta) {
      // RULE 3, and it is checked BEFORE the row is read: a caller must not be
      // able to learn whether an id is theirs by the shape of the refusal.
      if (id === principal.userId) {
        throw forbidden(
          "Anda tidak dapat mengubah peran akun Anda sendiri. Minta pengguna lain yang berwenang.",
        );
      }
      return db.transaction(async (tx) => {
        const sebelum = await penggunaTerjangkau(tx, principal, id);
        const peran = await periksaPeran(tx, principal, peranDiminta);
        // REVOKING is also a privilege change, so the roles being TAKEN AWAY
        // are checked too: an Admin Cabang must not be able to strip the
        // ADMIN_PUSAT role off an account that wandered into its branch.
        for (const lama of tampil(sebelum).peran) {
          if (isRoleCode(lama.kode) && !peran.some((p) => p.kode === lama.kode)) {
            assertBolehMemberiPeran(lama.kode, principal.permissions, principal.lintasCabang);
          }
        }
        await adminRepo.gantiPeran(tx, { userId: id, peran, olehUserId: principal.userId });
        const sesudah = await adminRepo.findPenggunaById(tx, id);
        if (!sesudah) throw notFound("Pengguna tidak ditemukan");
        await audit.record(
          {
            userId: principal.userId,
            aksi: "organisasi.pengguna.peran",
            entitas: "app_user",
            entitasId: id,
            nilaiLama: { peran: sebelum.peran ?? [] },
            nilaiBaru: { peran: sesudah.peran ?? [] },
            hasil: "SUKSES",
            keterangan: "peran pengguna diganti",
          },
          tx,
        );
        return tampil(sesudah);
      });
    },

    async setAktifPengguna(principal, id, aktif, alasan) {
      if (id === principal.userId) {
        throw forbidden("Anda tidak dapat menonaktifkan akun Anda sendiri");
      }
      return db.transaction(async (tx) => {
        const sebelum = await penggunaTerjangkau(tx, principal, id);
        // Deactivating an account that outranks the caller would be a denial of
        // service against a privilege the caller cannot itself hold.
        for (const dipegang of tampil(sebelum).peran) {
          if (isRoleCode(dipegang.kode)) {
            assertBolehMemberiPeran(dipegang.kode, principal.permissions, principal.lintasCabang);
          }
        }
        const sesudah = await adminRepo.setAktifPengguna(tx, { id, aktif, userId: principal.userId });
        if (!sesudah) throw notFound("Pengguna tidak ditemukan");
        await audit.record(
          {
            userId: principal.userId,
            aksi: "organisasi.pengguna.status",
            entitas: "app_user",
            entitasId: id,
            nilaiLama: { aktif: sebelum.aktif },
            nilaiBaru: { aktif },
            hasil: "SUKSES",
            keterangan: alasan
              ? `${aktif ? "diaktifkan" : "dinonaktifkan"}: ${alasan}`
              : aktif
                ? "pengguna diaktifkan"
                : "pengguna dinonaktifkan",
          },
          tx,
        );
        return tampil(sesudah);
      });
    },

    async resetSandi(principal, id) {
      const sandiSementara = buatSandiSementara();
      const passwordHash = await Bun.password.hash(sandiSementara, argon);
      return db.transaction(async (tx) => {
        const row = await penggunaTerjangkau(tx, principal, id);
        for (const dipegang of tampil(row).peran) {
          if (isRoleCode(dipegang.kode)) {
            // Resetting somebody's password is taking over their account. A
            // caller may only do that to an account whose authority they could
            // have granted in the first place.
            assertBolehMemberiPeran(dipegang.kode, principal.permissions, principal.lintasCabang);
          }
        }
        const n = await adminRepo.setSandiPengguna(tx, {
          id,
          passwordHash,
          harusGanti: true,
          userId: principal.userId,
        });
        if (n === 0) throw notFound("Pengguna tidak ditemukan");
        await audit.record(
          {
            userId: principal.userId,
            aksi: "organisasi.pengguna.reset_sandi",
            entitas: "app_user",
            entitasId: id,
            nilaiBaru: { username: row.username, harusGantiSandi: true },
            hasil: "SUKSES",
            keterangan: "sandi sementara diterbitkan ulang oleh administrator",
          },
          tx,
        );
        return { id, username: row.username, sandiSementara };
      });
    },

    async buatCabang(principal, body) {
      const kode = typeof body.kode === "string" ? body.kode.trim().toUpperCase() : "";
      const nama = teks(body.nama, 200);
      const galat: Record<string, string[]> = {};
      if (!POLA_KODE_CABANG.test(kode)) galat.kode = ["1 sampai 10 karakter, huruf besar, angka, . _ -"];
      if (!nama) galat.nama = ["wajib diisi"];
      if (Object.keys(galat).length > 0) throw badRequest("Data cabang belum valid", galat);

      const isPusat = body.isPusat === true;
      return db.transaction(async (tx) => {
        if (isPusat && (await adminRepo.adaPusat(tx, principal.bumnId))) {
          // `cabang_satu_pusat_uq` would refuse this anyway; saying so in a
          // sentence is the difference between an operator understanding the
          // rule and reading an index name.
          throw conflict(
            "Entitas ini sudah punya kantor pusat. Satu entitas hanya boleh punya satu kantor pusat.",
          );
        }
        if (await adminRepo.kodeCabangDipakai(tx, principal.bumnId, kode)) {
          throw conflict(`Kode cabang "${kode}" sudah dipakai di entitas ini`);
        }
        const row = await adminRepo.insertCabang(tx, {
          bumnId: principal.bumnId,
          kode,
          nama: nama!,
          alamat: teks(body.alamat, 500),
          kotaId: typeof body.kotaId === "string" && body.kotaId.length > 0 ? body.kotaId : null,
          isPusat,
          userId: principal.userId,
        });
        await audit.record(
          {
            userId: principal.userId,
            aksi: "organisasi.cabang.buat",
            entitas: "cabang",
            entitasId: row.id,
            nilaiBaru: { kode: row.kode, nama: row.nama, isPusat: row.is_pusat },
            hasil: "SUKSES",
            keterangan: "cabang dibuat",
          },
          tx,
        );
        return row;
      });
    },

    async ubahCabang(principal, id, body) {
      return db.transaction(async (tx) => {
        const sebelum = await cabangDalamEntitas(tx, principal, id);
        const sesudah = await adminRepo.updateCabang(tx, {
          id,
          nama: teks(body.nama, 200),
          alamat: teks(body.alamat, 500),
          kotaId: typeof body.kotaId === "string" && body.kotaId.length > 0 ? body.kotaId : null,
          userId: principal.userId,
          version: typeof body.version === "number" ? body.version : null,
        });
        if (!sesudah) {
          throw conflict("Data cabang sudah berubah sejak Anda membukanya. Muat ulang lalu ulangi.");
        }
        await audit.record(
          {
            userId: principal.userId,
            aksi: "organisasi.cabang.ubah",
            entitas: "cabang",
            entitasId: id,
            nilaiLama: { nama: sebelum.nama, alamat: sebelum.alamat },
            nilaiBaru: { nama: sesudah.nama, alamat: sesudah.alamat },
            hasil: "SUKSES",
            keterangan: "cabang diubah",
          },
          tx,
        );
        return sesudah;
      });
    },

    async setAktifCabang(principal, id, aktif) {
      return db.transaction(async (tx) => {
        const sebelum = await cabangDalamEntitas(tx, principal, id);
        if (!aktif && sebelum.is_pusat) {
          throw conflict(
            "Kantor pusat tidak dapat dinonaktifkan: seri penomoran tingkat pusat dan kepala " +
              "setiap laporan menggantung padanya.",
          );
        }
        if (!aktif) {
          // WHY THIS REFUSAL EXISTS. `app_user` is joined to `cabang` on every
          // request, and the join only filters `deleted_at`, not `aktif`. So a
          // deactivated branch whose users are still active is a branch that is
          // closed on every screen and open on every login. Refusing here, and
          // naming the count, makes the operator do the two steps in the order
          // that leaves no gap.
          const jumlah = await adminRepo.jumlahPenggunaAktif(tx, id);
          if (jumlah > 0) {
            throw conflict(
              `Cabang ini masih punya ${jumlah} pengguna aktif. Nonaktifkan penggunanya lebih ` +
                "dulu, lalu nonaktifkan cabangnya.",
            );
          }
        }
        const sesudah = await adminRepo.setAktifCabang(tx, { id, aktif, userId: principal.userId });
        if (!sesudah) throw notFound("Cabang tidak ditemukan");
        await audit.record(
          {
            userId: principal.userId,
            aksi: "organisasi.cabang.status",
            entitas: "cabang",
            entitasId: id,
            nilaiLama: { aktif: sebelum.aktif },
            nilaiBaru: { aktif },
            hasil: "SUKSES",
            keterangan: aktif ? "cabang diaktifkan" : "cabang dinonaktifkan",
          },
          tx,
        );
        return sesudah;
      });
    },

    async buatKaryawan(principal, body) {
      const nama = teks(body.nama, 200);
      if (!nama) throw badRequest("Data karyawan belum valid", { nama: ["wajib diisi"] });
      if (typeof body.cabangId !== "string" || !POLA_UUID.test(body.cabangId)) {
        throw badRequest("Data karyawan belum valid", { cabangId: ["wajib berupa UUID cabang"] });
      }
      return db.transaction(async (tx) => {
        const cabang = await cabangDalamEntitas(tx, principal, body.cabangId);
        assertCabangAllowed(principal, cabang.id);
        const nip = teks(body.nip, 50);
        if (nip && (await adminRepo.nipKaryawanDipakai(tx, nip, null))) {
          throw conflict(`NIP "${nip}" sudah dipakai karyawan lain`);
        }
        const row = await adminRepo.insertKaryawan(tx, {
          cabangId: cabang.id,
          nip,
          nama,
          jabatan: teks(body.jabatan, 200),
          unit: teks(body.unit, 200),
          userId: principal.userId,
        });
        await audit.record(
          {
            userId: principal.userId,
            aksi: "organisasi.karyawan.buat",
            entitas: "karyawan",
            entitasId: row.id,
            nilaiBaru: { nama: row.nama, nip: row.nip, cabangId: row.cabang_id },
            hasil: "SUKSES",
            keterangan: "karyawan dibuat",
          },
          tx,
        );
        return row;
      });
    },

    async ubahKaryawan(principal, id, body) {
      return db.transaction(async (tx) => {
        if (!POLA_UUID.test(id)) throw badRequest("Format identitas karyawan tidak valid");
        const sebelum = await repo.findKaryawanById(tx, id);
        if (!sebelum || sebelum.bumn_id !== principal.bumnId) throw notFound("Karyawan tidak ditemukan");
        assertCabangAllowed(principal, sebelum.cabang_id);
        let cabangId: string | null = null;
        if (typeof body.cabangId === "string" && body.cabangId.length > 0) {
          const cabang = await cabangDalamEntitas(tx, principal, body.cabangId);
          assertCabangAllowed(principal, cabang.id);
          cabangId = cabang.id;
        }
        const nipBaru = teks(body.nip, 50);
        if (nipBaru && (await adminRepo.nipKaryawanDipakai(tx, nipBaru, id))) {
          throw conflict(`NIP "${nipBaru}" sudah dipakai karyawan lain`);
        }
        const sesudah = await adminRepo.updateKaryawan(tx, {
          id,
          nama: teks(body.nama, 200),
          nip: nipBaru,
          jabatan: teks(body.jabatan, 200),
          unit: teks(body.unit, 200),
          cabangId,
          userId: principal.userId,
          version: typeof body.version === "number" ? body.version : null,
        });
        if (!sesudah) {
          throw conflict("Data karyawan sudah berubah sejak Anda membukanya. Muat ulang lalu ulangi.");
        }
        await audit.record(
          {
            userId: principal.userId,
            aksi: "organisasi.karyawan.ubah",
            entitas: "karyawan",
            entitasId: id,
            nilaiLama: { nama: sebelum.nama, jabatan: sebelum.jabatan, unit: sebelum.unit },
            nilaiBaru: { nama: sesudah.nama, jabatan: sesudah.jabatan, unit: sesudah.unit },
            hasil: "SUKSES",
            keterangan: "karyawan diubah",
          },
          tx,
        );
        return sesudah;
      });
    },

    async setAktifKaryawan(principal, id, aktif) {
      return db.transaction(async (tx) => {
        if (!POLA_UUID.test(id)) throw badRequest("Format identitas karyawan tidak valid");
        const sebelum = await repo.findKaryawanById(tx, id);
        if (!sebelum || sebelum.bumn_id !== principal.bumnId) throw notFound("Karyawan tidak ditemukan");
        assertCabangAllowed(principal, sebelum.cabang_id);
        const sesudah = await adminRepo.setAktifKaryawan(tx, { id, aktif, userId: principal.userId });
        if (!sesudah) throw notFound("Karyawan tidak ditemukan");
        await audit.record(
          {
            userId: principal.userId,
            aksi: "organisasi.karyawan.status",
            entitas: "karyawan",
            entitasId: id,
            nilaiLama: { aktif: sebelum.aktif },
            nilaiBaru: { aktif },
            hasil: "SUKSES",
            keterangan: aktif ? "karyawan diaktifkan" : "karyawan dinonaktifkan",
          },
          tx,
        );
        return sesudah;
      });
    },
  };
}
