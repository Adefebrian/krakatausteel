// The mitra engine. Framework-agnostic: nothing here imports Hono.
//
// Read ./contract.ts first; its header is the argument for why a mitra is its
// own principal instead of a role on `app_user`. This file implements three
// things that argument requires:
//
//   ONE REFUSAL FOR EVERY LOGIN FAILURE, with the unknown-email path paying
//   for a real argon2id verification against a throwaway hash so it is not
//   measurably faster than a wrong password. Identical to modules/auth's rule
//   1, for identical reasons.
//
//   THE PER-EMAIL FAILURE BUDGET IS CONSUMED AFTER VERIFICATION, ON FAILURE
//   ONLY, AND A SUCCESS RESETS IT. core/hardening.ts records what the other
//   order cost the staff login: a few wrong guesses at a name and the real
//   owner's correct password was refused with 429 for the rest of the window,
//   from any address, because the limiter is fail-closed. That shape is not
//   reintroduced here.
//
//   NO AUTHORISATION FACT IS CACHED IN THE SESSION. The record holds an
//   account id; the account, the mitra and the branch are re-read from
//   Postgres on every request, so deactivating an account or soft-deleting a
//   mitra takes effect on the next request rather than at session expiry.
import {
  BATAS_MASUK_PER_EMAIL,
  BATAS_MASUK_PER_IP,
  JENDELA_MASUK_DETIK,
  KODE_MITRA,
  MAKS_PANJANG_SANDI,
  MIN_PANJANG_SANDI,
  MitraError,
  PERMISSION_MITRA,
  type AkadMitra,
  type BuatAkunInput,
  type HasilBuatAkun,
  type HasilMasuk,
  type JadwalMitra,
  type MasukInput,
  type MitraEngine,
  type MitraEngineDeps,
  type MitraPrincipal,
  type PembayaranMitra,
  type ProfilMitra,
} from "./contract";
import { createMitraRepo, profilDari, type BarisAkun, type MitraRepo } from "./repo";

const PESAN: Readonly<Record<string, string>> = {
  KREDENSIAL_MITRA_SALAH: "Email atau kata sandi salah.",
  SESI_MITRA_TIDAK_VALID: "Sesi tidak valid atau sudah berakhir.",
  WAJIB_GANTI_SANDI: "Ganti kata sandi Anda dulu sebelum membuka halaman lain.",
  SANDI_TIDAK_MEMENUHI_SYARAT: `Kata sandi baru minimal ${MIN_PANJANG_SANDI} karakter dan tidak boleh sama dengan email Anda.`,
  TERLALU_BANYAK_PERCOBAAN_MASUK: "Terlalu banyak percobaan masuk. Coba lagi nanti.",
  AKAD_TIDAK_DITEMUKAN: "Akad tidak ditemukan.",
  MITRA_TIDAK_DITEMUKAN: "Mitra tidak ditemukan.",
  AKUN_MITRA_SUDAH_ADA: "Mitra ini sudah punya akun portal.",
  AKUN_MITRA_TIDAK_DITEMUKAN: "Mitra ini belum punya akun portal.",
  EMAIL_TIDAK_VALID: "Format email tidak valid.",
  TIDAK_BERWENANG: "Anda tidak punya wewenang untuk tindakan ini.",
  CABANG_DILUAR_SCOPE: "Data ini berada di luar cabang Anda.",
};

function tolak(kode: keyof typeof KODE_MITRA, detail?: Record<string, unknown>): MitraError {
  return new MitraError(KODE_MITRA[kode], PESAN[kode] ?? kode, detail);
}

const POLA_EMAIL = /^[^\s@]{1,64}@[^\s@.]{1,63}(\.[^\s@.]{1,63})+$/;
const POLA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Alphabet for a generated one-time password: unambiguous in print and safe to
 * read aloud over a phone, which is how an officer actually hands one over.
 */
const ALFABET_SANDI = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function buatSandiSementara(panjang = 16): string {
  const bytes = new Uint8Array(panjang);
  crypto.getRandomValues(bytes);
  let keluar = "";
  for (const b of bytes) keluar += ALFABET_SANDI[b % ALFABET_SANDI.length];
  return keluar;
}

let hashUmpan: Promise<string> | undefined;
function getHashUmpan(options: { memoryCost?: number; timeCost?: number }): Promise<string> {
  if (!hashUmpan) {
    hashUmpan = Bun.password.hash(crypto.randomUUID(), { algorithm: "argon2id", ...options });
  }
  return hashUmpan;
}

export function createMitraEngine(deps: MitraEngineDeps): MitraEngine {
  const repo: MitraRepo = createMitraRepo();
  const prefix = deps.keyPrefix ?? "tjsl";
  const argon = { algorithm: "argon2id" as const, ...(deps.passwordOptions ?? {}) };

  const perIp = deps.batasMasuk?.perIp ?? BATAS_MASUK_PER_IP;
  const perEmail = deps.batasMasuk?.perEmail ?? BATAS_MASUK_PER_EMAIL;
  const jendela = deps.batasMasuk?.windowSeconds ?? JENDELA_MASUK_DETIK;

  const kunciIp = (ip: string | null): string => `${prefix}:mitra:masuk:ip:${ip ?? "no-ip"}`;
  const kunciEmail = (email: string): string => `${prefix}:mitra:masuk:email:${email.toLowerCase()}`;

  function principalDari(b: BarisAkun, sessionId: string): MitraPrincipal {
    return {
      sessionId,
      akunId: b.akun_id,
      mitraId: b.mitra_id,
      cabangId: b.cabang_id,
      bumnId: b.bumn_id,
      email: b.email,
      namaMitra: b.nama_lengkap,
      kodeMitra: b.kode_mitra,
      harusGantiSandi: b.harus_ganti_sandi,
    };
  }

  /**
   * A mitra action's audit row.
   *
   * `userId` IS ALWAYS NULL, and that is not laziness: `audit_log.user_id` is
   * a foreign key to `app_user` (migrations/0014), and a mitra is not one. The
   * account is named in `entitas` / `entitas_id` instead, so the trail stays
   * complete without a borrower ever appearing in the employee table.
   */
  async function catat(entry: {
    akunId: string | null;
    ip: string | null;
    userAgent: string | null;
    aksi: string;
    hasil: "SUKSES" | "DITOLAK";
    keterangan: string;
    nilaiBaru?: unknown;
  }): Promise<void> {
    await deps.audit.record({
      userId: null,
      ip: entry.ip,
      userAgent: entry.userAgent,
      aksi: entry.aksi,
      entitas: "portal_akun_mitra",
      entitasId: entry.akunId,
      ...(entry.nilaiBaru !== undefined ? { nilaiBaru: entry.nilaiBaru } : {}),
      hasil: entry.hasil,
      keterangan: entry.keterangan,
    });
  }

  function wajibIzin(ctx: { permissions: readonly string[] }, izin: string): void {
    if (!ctx.permissions.includes(izin)) throw tolak("TIDAK_BERWENANG", { butuh: izin });
  }

  return {
    async masuk(input: MasukInput): Promise<HasilMasuk> {
      const email = typeof input.email === "string" ? input.email.trim() : "";
      const sandi = typeof input.sandi === "string" ? input.sandi : "";
      const aktor = { ip: input.ip, userAgent: input.userAgent?.slice(0, 512) ?? null };

      // Per-IP first and unconditionally: this bounds how much argon2 work one
      // source can ask for, and unlike the per-email counter it cannot be
      // aimed at somebody else's account.
      const sisaIp = await deps.pembatas.consume(kunciIp(input.ip), perIp, jendela);
      if (!sisaIp.allowed) {
        await catat({
          akunId: null,
          ...aktor,
          aksi: "mitra.masuk",
          hasil: "DITOLAK",
          keterangan: `rate limit masuk mitra terlampaui (per IP) untuk ${email.slice(0, 80)}`,
        });
        throw tolak("TERLALU_BANYAK_PERCOBAAN_MASUK", {
          retryAfterSeconds: Math.max(1, sisaIp.retryAfterSeconds),
        });
      }

      /** The single refusal. See the file header for why the order matters. */
      const gagal = async (alasan: string, akunId: string | null): Promise<never> => {
        const sisa = await deps.pembatas.consume(kunciEmail(email), perEmail, jendela);
        await catat({ akunId, ...aktor, aksi: "mitra.masuk", hasil: "DITOLAK", keterangan: alasan });
        if (!sisa.allowed) {
          throw tolak("TERLALU_BANYAK_PERCOBAAN_MASUK", {
            retryAfterSeconds: Math.max(1, sisa.retryAfterSeconds),
          });
        }
        throw tolak("KREDENSIAL_MITRA_SALAH");
      };

      if (email.length === 0 || email.length > 200 || sandi.length === 0 || sandi.length > MAKS_PANJANG_SANDI) {
        await Bun.password.verify("x", await getHashUmpan(deps.passwordOptions ?? {})).catch(() => false);
        return gagal("masuk mitra: bentuk kredensial tidak valid", null);
      }

      const akun = await repo.akunByEmail(deps.db, email);
      if (!akun) {
        // Constant-work path, exactly as modules/auth does it.
        await Bun.password.verify(sandi, await getHashUmpan(deps.passwordOptions ?? {})).catch(() => false);
        return gagal("masuk mitra: email tidak ditemukan", null);
      }
      if (!akun.aktif || !akun.mitra_aktif) {
        await Bun.password.verify(sandi, akun.password_hash).catch(() => false);
        return gagal("masuk mitra: akun atau mitra tidak aktif", akun.akun_id);
      }

      const cocok = await Bun.password.verify(sandi, akun.password_hash).catch(() => false);
      if (!cocok) return gagal("masuk mitra: kata sandi salah", akun.akun_id);

      const sesi = await deps.sesi.create({
        akunId: akun.akun_id,
        ip: input.ip,
        userAgent: aktor.userAgent,
      });
      await repo.catatMasuk(deps.db, akun.akun_id);
      // Clears the failure budget: the account is demonstrably in the hands of
      // whoever knows its password, so somebody else's wrong guesses must stop
      // counting against it. The per-IP counter stays; it is the spray defence.
      await deps.pembatas.reset(kunciEmail(email));

      await catat({
        akunId: akun.akun_id,
        ...aktor,
        aksi: "mitra.masuk",
        hasil: "SUKSES",
        keterangan: "login mitra berhasil",
        nilaiBaru: { mitraId: akun.mitra_id, kodeMitra: akun.kode_mitra },
      });

      const principal = principalDari(akun, sesi.id);
      return { sesi, principal, profil: profilDari(akun) };
    },

    async keluar(sessionId, ip, userAgent): Promise<void> {
      const record = await deps.sesi.touch(sessionId).catch(() => null);
      const dihapus = await deps.sesi.destroy(sessionId);
      await catat({
        akunId: record?.akunId ?? null,
        ip,
        userAgent: userAgent?.slice(0, 512) ?? null,
        aksi: "mitra.keluar",
        hasil: "SUKSES",
        keterangan: dihapus ? "sesi mitra dihapus" : "sesi mitra sudah tidak ada",
      });
    },

    async resolveSesi(sessionId): Promise<MitraPrincipal | null> {
      const record = await deps.sesi.touch(sessionId);
      if (!record) return null;
      const akun = await repo.akunById(deps.db, record.akunId);
      if (!akun || !akun.aktif || !akun.mitra_aktif) {
        // Deactivated (or the mitra soft-deleted) while holding a live
        // session: drop the session rather than let it keep resolving.
        await deps.sesi.destroy(record.id);
        return null;
      }
      return principalDari(akun, record.id);
    },

    async profil(p): Promise<ProfilMitra> {
      const akun = await repo.akunById(deps.db, p.akunId);
      if (!akun) throw tolak("SESI_MITRA_TIDAK_VALID");
      return profilDari(akun);
    },

    async daftarAkad(p): Promise<AkadMitra[]> {
      return repo.daftarAkad(deps.db, p.mitraId);
    },

    async jadwal(akadId, p): Promise<JadwalMitra> {
      if (!POLA_UUID.test(akadId)) throw tolak("AKAD_TIDAK_DITEMUKAN", { akadId });
      const akad = await repo.akadMilik(deps.db, p.mitraId, akadId);
      // Same refusal for "no such akad" and "not yours". See KODE_MITRA.
      if (!akad) throw tolak("AKAD_TIDAK_DITEMUKAN", { akadId });
      return {
        akadId: akad.id,
        noAkad: akad.no_akad,
        versi: akad.versi,
        outstandingPokok: akad.outstanding_pokok,
        outstandingJasa: akad.outstanding_jasa,
        baris: await repo.jadwalAkad(deps.db, p.mitraId, akadId),
      };
    },

    async pembayaran(akadId, p): Promise<PembayaranMitra[]> {
      if (!POLA_UUID.test(akadId)) throw tolak("AKAD_TIDAK_DITEMUKAN", { akadId });
      const akad = await repo.akadMilik(deps.db, p.mitraId, akadId);
      if (!akad) throw tolak("AKAD_TIDAK_DITEMUKAN", { akadId });
      return repo.pembayaranAkad(deps.db, p.mitraId, akadId);
    },

    async gantiSandi(p, input): Promise<void> {
      const akun = await repo.akunById(deps.db, p.akunId);
      if (!akun || !akun.aktif || !akun.mitra_aktif) throw tolak("SESI_MITRA_TIDAK_VALID");

      const lama = typeof input.sandiLama === "string" ? input.sandiLama : "";
      const baru = typeof input.sandiBaru === "string" ? input.sandiBaru : "";

      const cocok = await Bun.password.verify(lama, akun.password_hash).catch(() => false);
      if (!cocok) {
        // Counts against the same per-email budget a login failure does: this
        // endpoint verifies the same secret, so leaving it uncounted would be
        // an unmetered oracle for the current password.
        await deps.pembatas.consume(kunciEmail(akun.email), perEmail, jendela);
        await catat({
          akunId: akun.akun_id,
          ip: input.ip,
          userAgent: input.userAgent,
          aksi: "mitra.ganti_sandi",
          hasil: "DITOLAK",
          keterangan: "ganti sandi mitra: kata sandi lama salah",
        });
        throw tolak("KREDENSIAL_MITRA_SALAH");
      }

      if (
        baru.length < MIN_PANJANG_SANDI ||
        baru.length > MAKS_PANJANG_SANDI ||
        baru.toLowerCase() === akun.email.toLowerCase() ||
        baru === lama
      ) {
        throw tolak("SANDI_TIDAK_MEMENUHI_SYARAT");
      }

      const hash = await Bun.password.hash(baru, argon);
      const n = await repo.simpanSandi(deps.db, akun.akun_id, hash);
      if (n === 0) throw tolak("SESI_MITRA_TIDAK_VALID");

      await catat({
        akunId: akun.akun_id,
        ip: input.ip,
        userAgent: input.userAgent,
        aksi: "mitra.ganti_sandi",
        hasil: "SUKSES",
        keterangan: "kata sandi mitra diganti oleh pemiliknya",
      });
    },

    // ------------------------------------------------------------- staff

    async buatAkun(input: BuatAkunInput, ctx): Promise<HasilBuatAkun> {
      wajibIzin(ctx, PERMISSION_MITRA.KELOLA_AKUN);
      const email = typeof input.email === "string" ? input.email.trim() : "";
      if (!POLA_EMAIL.test(email) || email.length > 200) throw tolak("EMAIL_TIDAK_VALID", { email });
      if (!POLA_UUID.test(input.mitraId)) throw tolak("MITRA_TIDAK_DITEMUKAN", { mitraId: input.mitraId });

      return deps.db.transaction(async (tx) => {
        const mitra = await repo.mitraUntukAkun(tx, ctx.bumnId, input.mitraId);
        if (!mitra) throw tolak("MITRA_TIDAK_DITEMUKAN", { mitraId: input.mitraId });
        // Branch scope, spec 2 rule 3: the row states its own branch and the
        // SESSION says which branches the officer may act in. Nothing from the
        // request participates in this decision.
        const scope = ctx.cabangDalamScope;
        if (scope && scope.length > 0 && !scope.includes(mitra.cabang_id)) {
          throw tolak("CABANG_DILUAR_SCOPE", { cabangId: mitra.cabang_id });
        }
        const ada = await repo.akunByMitra(tx, input.mitraId);
        if (ada) throw tolak("AKUN_MITRA_SUDAH_ADA", { mitraId: input.mitraId });

        const sandiSementara = buatSandiSementara();
        const hash = await Bun.password.hash(sandiSementara, argon);
        const akunId = await repo.buatAkun(tx, {
          mitraId: input.mitraId,
          email,
          hash,
          userId: ctx.userId,
        });

        await deps.audit.record(
          {
            userId: ctx.userId,
            aksi: "mitra.akun.buat",
            entitas: "portal_akun_mitra",
            entitasId: akunId,
            // The password is NOT in the audit row. It is a live credential
            // for the length of one handover, and audit_log is readable by
            // every holder of `audit.view`.
            nilaiBaru: { mitraId: input.mitraId, email },
            hasil: "SUKSES",
            keterangan: "akun portal mitra dibuat dengan sandi sementara",
          },
          tx,
        );

        return { akunId, mitraId: input.mitraId, email, sandiSementara };
      });
    },

    async setAktifAkun(mitraId, aktif, ctx) {
      wajibIzin(ctx, PERMISSION_MITRA.KELOLA_AKUN);
      if (!POLA_UUID.test(mitraId)) throw tolak("MITRA_TIDAK_DITEMUKAN", { mitraId });

      return deps.db.transaction(async (tx) => {
        const mitra = await repo.mitraUntukAkun(tx, ctx.bumnId, mitraId);
        if (!mitra) throw tolak("MITRA_TIDAK_DITEMUKAN", { mitraId });
        const scope = ctx.cabangDalamScope;
        if (scope && scope.length > 0 && !scope.includes(mitra.cabang_id)) {
          throw tolak("CABANG_DILUAR_SCOPE", { cabangId: mitra.cabang_id });
        }
        const n = await repo.setAktif(tx, { mitraId, aktif, userId: ctx.userId });
        if (n === 0) throw tolak("AKUN_MITRA_TIDAK_DITEMUKAN", { mitraId });

        await deps.audit.record(
          {
            userId: ctx.userId,
            aksi: "mitra.akun.status",
            entitas: "portal_akun_mitra",
            entitasId: mitraId,
            nilaiBaru: { aktif },
            hasil: "SUKSES",
            keterangan: aktif ? "akun portal mitra diaktifkan" : "akun portal mitra dinonaktifkan",
          },
          tx,
        );
        return { mitraId, aktif };
      });
    },
  };
}
