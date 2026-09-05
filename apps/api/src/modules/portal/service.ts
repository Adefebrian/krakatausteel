// The portal engine. Framework-agnostic: nothing here imports Hono, so every
// rule below is testable by calling a function.
//
// Read ./contract.ts first; its header states the four rules this file
// implements. The two that decide the code's shape:
//
//   THE FORM IS AN ALLOWLIST. `validasiFormulir` refuses an unknown key
//   instead of storing it. `portal_submission.data_json` is JSONB with no
//   schema behind it, so without this the endpoint is an unbounded write
//   primitive handed to the internet.
//
//   THE STATUS CHECK IS A CREDENTIAL CHECK, and it is written against the
//   failure core/hardening.ts documents: a per-subject counter consumed BEFORE
//   verification turns the endpoint into a lockout weapon. Here the per-ticket
//   budget is consumed only AFTER a wrong answer, and a right answer resets
//   it, so a correct verifier always wins whatever anyone else has been
//   guessing.
import {
  aturanFormulir,
  BATAS_BARIS_BAWAAN,
  BATAS_BARIS_MAKS,
  BATAS_CEK_PER_IP,
  BATAS_CEK_PER_TIKET,
  BATAS_PENGAJUAN_PER_IP,
  BATAS_PENGAJUAN_PER_IP_HARIAN,
  JENDELA_CEK_DETIK,
  JENDELA_PENGAJUAN_DETIK,
  JENIS_DOKUMEN,
  KODE_PORTAL,
  MAKS_DOKUMEN,
  MAKS_ENTITAS_PUBLIK,
  MAKS_NAMA_FILE,
  PERMISSION_PORTAL,
  POLA_NIK,
  POLA_TANGGAL,
  POLA_TIKET,
  POLA_UANG,
  PortalError,
  type CekStatusInput,
  type DetailSubmission,
  type DokumenPengajuan,
  type EntitasPublik,
  type FilterSubmission,
  type HasilPengajuan,
  type JenisDokumen,
  type JenisPengajuan,
  type PengajuanInput,
  type PortalContext,
  type PortalEngine,
  type PortalEngineDeps,
  type PortalPublikContext,
  type RingkasanSubmission,
  type StatusPengajuan,
  type StatusSubmission,
  type TindakInput,
  type Uang,
} from "./contract";
import { createPortalRepo, type BarisSubmission, type PortalRepo } from "./repo";

const PESAN: Readonly<Record<string, string>> = {
  ENTITAS_TIDAK_DITEMUKAN: "Entitas tujuan pengajuan tidak dikenal.",
  FORMULIR_TIDAK_VALID: "Data pengajuan belum lengkap atau tidak sesuai format.",
  PEMERIKSA_WAJIB:
    "Isi salah satu saja: NIK atau tanggal lahir. Data itu dipakai untuk mengecek status nanti.",
  // ONE SENTENCE FOR EVERY FAILURE MODE. See KODE_PORTAL in ./contract.ts.
  TIKET_ATAU_PEMERIKSA_SALAH: "Nomor tiket atau data pemeriksa tidak cocok.",
  TERLALU_BANYAK_PENGAJUAN: "Terlalu banyak pengajuan dari jaringan ini. Coba lagi nanti.",
  TERLALU_BANYAK_PERCOBAAN: "Terlalu banyak percobaan. Coba lagi nanti.",
  SUBMISSION_TIDAK_DITEMUKAN: "Pengajuan dari portal tidak ditemukan.",
  SUBMISSION_SUDAH_DIKONVERSI:
    "Pengajuan ini sudah dikonversi menjadi proposal internal dan tidak bisa diubah lagi.",
  STATUS_TIDAK_BISA_DIUBAH: "Status pengajuan ini tidak bisa dipindahkan ke sana.",
  TIDAK_BERWENANG: "Anda tidak punya wewenang untuk tindakan ini.",
  IZIN_BELUM_TERDAFTAR: "Izin yang dibutuhkan belum terdaftar di katalog.",
};

/** Public messages, one per status. Never an officer's free text. */
const PESAN_STATUS: Readonly<Record<StatusSubmission, string>> = {
  BARU: "Pengajuan Anda sudah kami terima dan masuk antrean verifikasi.",
  DIPROSES: "Pengajuan Anda sedang diverifikasi petugas.",
  DIKONVERSI: "Pengajuan Anda sudah diproses lebih lanjut. Petugas akan menghubungi Anda.",
  DITOLAK: "Pengajuan Anda belum dapat kami lanjutkan. Silakan hubungi kantor cabang.",
};

function tolak(kode: keyof typeof KODE_PORTAL, detail?: Record<string, unknown>): PortalError {
  return new PortalError(KODE_PORTAL[kode], PESAN[kode] ?? kode, detail);
}

/**
 * Crockford base32 without I, L, O and U, so a ticket read aloud or copied off
 * a printout cannot become a different valid ticket.
 */
const ALFABET_TIKET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * `TKT-YYYYMM-XXXXXXXXXX`, the tail being 50 bits of CSPRNG output.
 *
 * THE SEQUENTIAL TICKET WAS THE PROBLEM. `TKT-202601-001` is guessable, and a
 * guessable ticket reduces the status check from "ticket AND verifier" to
 * "verifier", which for a date of birth is a few thousand tries. An
 * unguessable ticket is the first of the two factors actually being a factor.
 */
export function buatNoTiket(now: Date): string {
  const bulan = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let ekor = "";
  for (const b of bytes) ekor += ALFABET_TIKET[b % 32];
  return `TKT-${bulan}-${ekor}`;
}

/**
 * The string that is hashed. The KIND is part of the plaintext, so a NIK and a
 * date of birth can never collide, and the stored hash does not have to say
 * which kind it is (which would itself be a hint).
 */
function plaintextPemeriksa(input: { nik?: string | null; tanggalLahir?: string | null }): string | null {
  if (input.nik) return `NIK:${input.nik}`;
  if (input.tanggalLahir) return `LAHIR:${input.tanggalLahir}`;
  return null;
}

/** Rejects control characters outright rather than stripping them silently. */
const POLA_KENDALI = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

class Pemeriksa {
  readonly galat: Record<string, string[]> = {};

  tolak(field: string, pesan: string): void {
    (this.galat[field] ??= []).push(pesan);
  }

  get gagal(): boolean {
    return Object.keys(this.galat).length > 0;
  }
}

/**
 * Validates the submitted form against the allowlist for its kind, returning
 * the CANONICAL object that will be stored. Anything not named in the
 * allowlist is a refusal; nothing is coerced, and nothing extra is kept.
 */
export function validasiFormulir(
  jenis: JenisPengajuan,
  formulir: Record<string, unknown>,
): { nilai: Record<string, string | number>; galat: Record<string, string[]> } {
  const cek = new Pemeriksa();
  const aturan = aturanFormulir(jenis);
  const nilai: Record<string, string | number> = {};

  for (const kunci of Object.keys(formulir)) {
    if (!Object.hasOwn(aturan, kunci)) {
      // Not "ignored": a form that quietly drops fields teaches a submitter
      // that a field was accepted when it was not.
      cek.tolak(kunci, "field tidak dikenal");
    }
  }

  for (const [kunci, a] of Object.entries(aturan)) {
    const mentah = formulir[kunci];
    const kosong = mentah === undefined || mentah === null || mentah === "";
    if (kosong) {
      if (a.wajib) cek.tolak(kunci, "wajib diisi");
      continue;
    }
    if (a.jenis === "teks") {
      if (typeof mentah !== "string") {
        cek.tolak(kunci, "wajib berupa teks");
        continue;
      }
      const bersih = mentah.trim();
      if (bersih.length === 0) {
        if (a.wajib) cek.tolak(kunci, "wajib diisi");
        continue;
      }
      if (bersih.length > a.maks) {
        cek.tolak(kunci, `maksimal ${a.maks} karakter`);
        continue;
      }
      if (POLA_KENDALI.test(bersih)) {
        cek.tolak(kunci, "memuat karakter kendali yang tidak diizinkan");
        continue;
      }
      nilai[kunci] = bersih;
      continue;
    }
    if (a.jenis === "uang") {
      // A decimal STRING, never a JS number: a float here is a rounding error
      // that would travel into NUMERIC(20,2) at conversion time.
      if (typeof mentah !== "string" || !POLA_UANG.test(mentah)) {
        cek.tolak(kunci, "wajib berupa string desimal dengan dua angka di belakang koma");
        continue;
      }
      const sen = BigInt(mentah.replace(".", ""));
      if (sen <= 0n) {
        cek.tolak(kunci, "wajib lebih besar dari nol");
        continue;
      }
      if (sen > a.maksSen) {
        cek.tolak(kunci, "nilai terlalu besar");
        continue;
      }
      nilai[kunci] = mentah;
      continue;
    }
    // bulat
    if (typeof mentah !== "number" || !Number.isInteger(mentah)) {
      cek.tolak(kunci, "wajib bilangan bulat");
      continue;
    }
    if (mentah < a.min || mentah > a.maks) {
      cek.tolak(kunci, `wajib antara ${a.min} dan ${a.maks}`);
      continue;
    }
    nilai[kunci] = mentah;
  }

  return { nilai, galat: cek.galat };
}

const JENIS_DOKUMEN_SET: ReadonlySet<string> = new Set<string>(JENIS_DOKUMEN);
/**
 * A file name is DISPLAY TEXT here and nothing else, but it is one field away
 * from becoming an object-store key, so path separators and traversal are
 * refused at the boundary rather than escaped later by whoever writes that.
 */
const POLA_NAMA_FILE = /^[^/\\\u0000-\u001F]{1,160}$/;

export function validasiDokumen(
  dokumen: readonly unknown[],
): { nilai: DokumenPengajuan[]; galat: Record<string, string[]> } {
  const cek = new Pemeriksa();
  const nilai: DokumenPengajuan[] = [];
  if (dokumen.length > MAKS_DOKUMEN) {
    cek.tolak("dokumen", `maksimal ${MAKS_DOKUMEN} dokumen`);
    return { nilai, galat: cek.galat };
  }
  dokumen.forEach((d, i) => {
    if (typeof d !== "object" || d === null) {
      cek.tolak(`dokumen[${i}]`, "wajib berupa objek");
      return;
    }
    const { jenis, namaFile } = d as { jenis?: unknown; namaFile?: unknown };
    if (typeof jenis !== "string" || !JENIS_DOKUMEN_SET.has(jenis)) {
      cek.tolak(`dokumen[${i}].jenis`, `wajib salah satu dari: ${JENIS_DOKUMEN.join(", ")}`);
    }
    if (typeof namaFile !== "string" || !POLA_NAMA_FILE.test(namaFile.trim())) {
      cek.tolak(
        `dokumen[${i}].namaFile`,
        `wajib teks tanpa pemisah path, maksimal ${MAKS_NAMA_FILE} karakter`,
      );
    }
    if (!cek.gagal) {
      nilai.push({ jenis: jenis as JenisDokumen, namaFile: (namaFile as string).trim() });
    }
  });
  return { nilai, galat: cek.galat };
}

const POLA_EMAIL = /^[^\s@]{1,64}@[^\s@.]{1,63}(\.[^\s@.]{1,63})+$/;
const POLA_TELEPON = /^\+?[0-9][0-9 -]{6,19}$/;

/** A real calendar date, not merely something that matches the pattern. */
export function tanggalLahirValid(nilai: string, sekarang: Date): boolean {
  if (!POLA_TANGGAL.test(nilai)) return false;
  const t = new Date(`${nilai}T00:00:00Z`);
  if (Number.isNaN(t.getTime())) return false;
  if (t.toISOString().slice(0, 10) !== nilai) return false;
  if (t.getTime() > sekarang.getTime()) return false;
  return t.getUTCFullYear() >= 1900;
}

let hashUmpan: Promise<string> | undefined;
/**
 * A real argon2id hash of a value nobody knows, verified against whenever the
 * ticket does not exist so that path costs the same as a wrong verifier.
 * Built once, lazily, and never awaited at import time.
 */
function getHashUmpan(options: { memoryCost?: number; timeCost?: number }): Promise<string> {
  if (!hashUmpan) {
    hashUmpan = Bun.password.hash(crypto.randomUUID(), { algorithm: "argon2id", ...options });
  }
  return hashUmpan;
}

function bacaJson(teks: string): Record<string, unknown> {
  try {
    const nilai = JSON.parse(teks) as unknown;
    return typeof nilai === "object" && nilai !== null && !Array.isArray(nilai)
      ? (nilai as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function bacaDokumen(teks: string): DokumenPengajuan[] {
  try {
    const nilai = JSON.parse(teks) as unknown;
    if (!Array.isArray(nilai)) return [];
    return nilai.filter(
      (d): d is DokumenPengajuan =>
        typeof d === "object" &&
        d !== null &&
        typeof (d as DokumenPengajuan).jenis === "string" &&
        typeof (d as DokumenPengajuan).namaFile === "string",
    );
  } catch {
    return [];
  }
}

export function createPortalEngine(deps: PortalEngineDeps): PortalEngine {
  const repo: PortalRepo = createPortalRepo();
  const jam = deps.jam ?? (() => new Date());
  const prefix = deps.keyPrefix ?? "tjsl";
  const argon = { algorithm: "argon2id" as const, ...(deps.passwordOptions ?? {}) };

  const batasAjukanIp = deps.batas?.pengajuanPerIp ?? BATAS_PENGAJUAN_PER_IP;
  const batasAjukanHarian = deps.batas?.pengajuanPerIpHarian ?? BATAS_PENGAJUAN_PER_IP_HARIAN;
  const jendelaAjukan = deps.batas?.jendelaPengajuanDetik ?? JENDELA_PENGAJUAN_DETIK;
  const batasCekIp = deps.batas?.cekPerIp ?? BATAS_CEK_PER_IP;
  const batasCekTiket = deps.batas?.cekPerTiket ?? BATAS_CEK_PER_TIKET;
  const jendelaCek = deps.batas?.jendelaCekDetik ?? JENDELA_CEK_DETIK;

  const kunciIpAjukan = (ip: string | null): string => `${prefix}:portal:ajukan:ip:${ip ?? "no-ip"}`;
  const kunciIpCek = (ip: string | null): string => `${prefix}:portal:cek:ip:${ip ?? "no-ip"}`;
  const kunciTiket = (noTiket: string): string => `${prefix}:portal:cek:tiket:${noTiket}`;

  function wajibIzin(ctx: PortalContext, izin: string): void {
    if (!ctx.permissions.includes(izin)) {
      throw tolak("TIDAK_BERWENANG", { butuh: izin });
    }
  }

  function ringkasan(b: BarisSubmission & { punya_proposal?: boolean }): RingkasanSubmission {
    const data = bacaJson(b.data_json);
    const nama = data.nama_lengkap ?? data.nama_pemohon;
    const jumlah = data.jumlah_diajukan;
    return {
      id: b.id,
      noTiket: b.no_tiket,
      jenis: b.jenis,
      tanggalSubmit: b.tanggal_submit,
      status: b.status,
      namaPemohon: typeof nama === "string" ? nama : null,
      jumlahDiajukan: typeof jumlah === "string" ? (jumlah as Uang) : null,
      emailKontak: b.email_kontak,
      teleponKontak: b.telepon_kontak,
      sudahDikonversi: b.punya_proposal ?? b.converted_proposal_id !== null,
    };
  }

  function detailDari(b: BarisSubmission): DetailSubmission {
    return {
      ...ringkasan(b),
      formulir: bacaJson(b.data_json),
      dokumen: bacaDokumen(b.dokumen_json),
      catatanPetugas: b.catatan_petugas,
      convertedProposalId: b.converted_proposal_id,
    };
  }

  return {
    /**
     * ANONYMOUS, and the smallest public read in the system.
     *
     * NO RATE LIMIT IN THE ENGINE, deliberately, and that is not an omission:
     * the two public WRITE-shaped surfaces (`ajukan`, `cekStatus`) carry engine
     * limits because each of them consumes something an attacker wants to
     * exhaust -- a row in `portal_submission`, or an argon2id verification.
     * This one consumes a single indexed read of at most `MAKS_ENTITAS_PUBLIK`
     * rows and reveals what a leaflet reveals, so the honest protection is the
     * transport limiter and a hard row cap, both of which it has. Adding a
     * per-IP budget here would throttle a form's own page load and buy nothing.
     *
     * NO AUDIT ROW EITHER, for the same reason: `audit_log` records who
     * touched what, and this touches nothing.
     */
    async entitasPublik(): Promise<EntitasPublik[]> {
      return repo.daftarEntitasPublik(deps.db, MAKS_ENTITAS_PUBLIK);
    },

    async ajukan(input: PengajuanInput, ctx: PortalPublikContext): Promise<HasilPengajuan> {
      const sekarang = jam();
      const cek = new Pemeriksa();

      const jenis: JenisPengajuan | null =
        input.jenis === "PUMK" || input.jenis === "NON_PUMK" ? input.jenis : null;
      if (!jenis) cek.tolak("jenis", "wajib PUMK atau NON_PUMK");

      const kodeEntitas = typeof input.kodeEntitas === "string" ? input.kodeEntitas.trim() : "";
      if (kodeEntitas.length === 0 || kodeEntitas.length > 32) {
        cek.tolak("kodeEntitas", "wajib diisi, maksimal 32 karakter");
      }

      const email = typeof input.emailKontak === "string" ? input.emailKontak.trim() : "";
      if (email.length > 0 && !POLA_EMAIL.test(email)) {
        cek.tolak("emailKontak", "format email tidak valid");
      }
      const telepon = typeof input.teleponKontak === "string" ? input.teleponKontak.trim() : "";
      if (telepon.length > 0 && !POLA_TELEPON.test(telepon)) {
        cek.tolak("teleponKontak", "format nomor telepon tidak valid");
      }
      if (email.length === 0 && telepon.length === 0) {
        cek.tolak("emailKontak", "isi email atau nomor telepon agar bisa dihubungi");
      }

      // EXACTLY ONE verifier. Accepting both would mean two secrets guarding
      // one ticket, and an attacker only ever has to beat the weaker one.
      const nik = typeof input.nik === "string" ? input.nik.trim() : "";
      const lahir = typeof input.tanggalLahir === "string" ? input.tanggalLahir.trim() : "";
      if ((nik.length > 0) === (lahir.length > 0)) {
        cek.tolak("nik", "isi salah satu saja: nik atau tanggalLahir");
      } else if (nik.length > 0 && !POLA_NIK.test(nik)) {
        cek.tolak("nik", "wajib 16 digit angka");
      } else if (lahir.length > 0 && !tanggalLahirValid(lahir, sekarang)) {
        cek.tolak("tanggalLahir", "wajib tanggal YYYY-MM-DD yang masuk akal");
      }

      const formulirMentah =
        typeof input.formulir === "object" && input.formulir !== null && !Array.isArray(input.formulir)
          ? input.formulir
          : null;
      if (!formulirMentah) cek.tolak("formulir", "wajib berupa objek");

      const dokumenMentah = Array.isArray(input.dokumen) ? input.dokumen : [];

      if (jenis && formulirMentah) {
        const hasil = validasiFormulir(jenis, formulirMentah);
        for (const [k, v] of Object.entries(hasil.galat)) cek.galat[`formulir.${k}`] = v;
        const dok = validasiDokumen(dokumenMentah);
        for (const [k, v] of Object.entries(dok.galat)) cek.galat[k] = v;

        if (cek.gagal) throw tolak("FORMULIR_TIDAK_VALID", { galat: cek.galat });

        // --- anti-spam, spec 9.5 -------------------------------------------
        // Redis first (bounds a burst), then the durable count (survives a
        // flush). Both refuse with 429; neither says how close the caller is.
        const burst = await deps.pembatas.consume(
          kunciIpAjukan(ctx.ip),
          batasAjukanIp,
          jendelaAjukan,
        );
        if (!burst.allowed) {
          await deps.audit.record({
            ip: ctx.ip,
            userAgent: ctx.userAgent,
            aksi: "portal.ajukan",
            entitas: "portal_submission",
            hasil: "DITOLAK",
            keterangan: "rate limit pengajuan portal terlampaui (per IP, jendela pendek)",
          });
          throw tolak("TERLALU_BANYAK_PENGAJUAN", {
            retryAfterSeconds: Math.max(1, burst.retryAfterSeconds),
          });
        }

        const entitas = await repo.entitasAktif(deps.db, kodeEntitas);
        if (!entitas) throw tolak("ENTITAS_TIDAK_DITEMUKAN", { kodeEntitas });

        if (ctx.ip) {
          const harian = await repo.cacahPengajuanDariIp(deps.db, ctx.ip, 24);
          if (harian >= batasAjukanHarian) {
            await deps.audit.record({
              ip: ctx.ip,
              userAgent: ctx.userAgent,
              aksi: "portal.ajukan",
              entitas: "portal_submission",
              hasil: "DITOLAK",
              keterangan: `rate limit pengajuan portal terlampaui (${harian} pengajuan dalam 24 jam)`,
            });
            throw tolak("TERLALU_BANYAK_PENGAJUAN", { retryAfterSeconds: 3600 });
          }
        }

        const rahasia = plaintextPemeriksa({ nik: nik || null, tanggalLahir: lahir || null });
        if (!rahasia) throw tolak("PEMERIKSA_WAJIB");
        const pemeriksaHash = await Bun.password.hash(rahasia, argon);

        // THE VERIFIER IS NOT IN `nilai`: `validasiFormulir` only ever returns
        // allowlisted form keys, and neither `nik` nor `tanggalLahir` is one.
        // That is rule 4 of the module header, enforced by construction rather
        // than by a delete() somebody could remove.
        const baris = await repo.buatSubmission(deps.db, {
          bumnId: entitas.id,
          jenis,
          noTiket: buatNoTiket(sekarang),
          dataJson: JSON.stringify(hasil.nilai),
          dokumenJson: JSON.stringify(dok.nilai),
          emailKontak: email.length > 0 ? email : null,
          teleponKontak: telepon.length > 0 ? telepon : null,
          pemeriksaHash,
          ip: ctx.ip,
          userAgent: ctx.userAgent?.slice(0, 512) ?? null,
          tanggalSubmit: sekarang.toISOString(),
        });

        await deps.audit.record({
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          aksi: "portal.ajukan",
          entitas: "portal_submission",
          entitasId: baris.id,
          nilaiBaru: { noTiket: baris.no_tiket, jenis: baris.jenis },
          hasil: "SUKSES",
          keterangan: "pengajuan portal diterima",
        });

        return {
          noTiket: baris.no_tiket,
          jenis: baris.jenis,
          tanggalSubmit: baris.tanggal_submit,
          status: baris.status,
          pesan: PESAN_STATUS[baris.status],
        };
      }

      throw tolak("FORMULIR_TIDAK_VALID", { galat: cek.galat });
    },

    async cekStatus(input: CekStatusInput, ctx: PortalPublikContext): Promise<StatusPengajuan> {
      const sekarang = jam();
      const noTiket = typeof input.noTiket === "string" ? input.noTiket.trim().toUpperCase() : "";
      const nik = typeof input.nik === "string" ? input.nik.trim() : "";
      const lahir = typeof input.tanggalLahir === "string" ? input.tanggalLahir.trim() : "";

      // Per-IP first and unconditionally: this bounds how much argon2 work one
      // source can ask for, and unlike the per-ticket counter it cannot be
      // aimed at somebody else's application.
      const perIp = await deps.pembatas.consume(kunciIpCek(ctx.ip), batasCekIp, jendelaCek);
      if (!perIp.allowed) {
        throw tolak("TERLALU_BANYAK_PERCOBAAN", {
          retryAfterSeconds: Math.max(1, perIp.retryAfterSeconds),
        });
      }

      /**
       * Everything that is not a correct answer ends here: the same code, the
       * same sentence, the same HTTP status, whether the ticket exists or not.
       *
       * The per-ticket budget is consumed HERE, after the verification, and
       * only for a ticket that actually exists. Consuming it up front would
       * reproduce the login limiter's old shape (core/hardening.ts): a few
       * wrong guesses and the real applicant's correct NIK is refused for the
       * rest of the window, from any address.
       */
      const gagal = async (id: string | null, alasan: string): Promise<never> => {
        let habis = false;
        if (id) {
          const sisa = await deps.pembatas.consume(kunciTiket(noTiket), batasCekTiket, jendelaCek);
          habis = !sisa.allowed;
          await deps.db.transaction((tx) => repo.catatPercobaanGagal(tx, id));
        }
        await deps.audit.record({
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          aksi: "portal.cek_status",
          entitas: "portal_submission",
          entitasId: id,
          hasil: "DITOLAK",
          keterangan: alasan,
        });
        if (habis) throw tolak("TERLALU_BANYAK_PERCOBAAN", { retryAfterSeconds: jendelaCek });
        throw tolak("TIKET_ATAU_PEMERIKSA_SALAH");
      };

      const rahasia = plaintextPemeriksa({ nik: nik || null, tanggalLahir: lahir || null });
      const bentukSalah =
        !POLA_TIKET.test(noTiket) ||
        rahasia === null ||
        (nik.length > 0 && lahir.length > 0) ||
        (nik.length > 0 && !POLA_NIK.test(nik)) ||
        (lahir.length > 0 && !tanggalLahirValid(lahir, sekarang));

      if (bentukSalah) {
        // Still pays for one argon2 verification: a malformed request must not
        // be measurably faster than a well-formed wrong one, or the shape of
        // the ticket becomes discoverable by timing.
        await Bun.password.verify("x", await getHashUmpan(deps.passwordOptions ?? {})).catch(() => false);
        return gagal(null, "cek status portal: format tiket atau pemeriksa tidak valid");
      }

      const baris = await repo.submissionByTiket(deps.db, noTiket);
      if (!baris || !baris.pemeriksa_hash) {
        await Bun.password.verify(rahasia, await getHashUmpan(deps.passwordOptions ?? {})).catch(() => false);
        return gagal(null, "cek status portal: tiket tidak ditemukan");
      }

      const cocok = await Bun.password.verify(rahasia, baris.pemeriksa_hash).catch(() => false);
      if (!cocok) return gagal(baris.id, "cek status portal: pemeriksa tidak cocok");

      // A correct answer clears the failure budget, so previous wrong guesses
      // (possibly somebody else's) stop counting against this ticket.
      await deps.pembatas.reset(kunciTiket(noTiket));

      return {
        noTiket: baris.no_tiket,
        jenis: baris.jenis,
        tanggalSubmit: baris.tanggal_submit,
        status: baris.status,
        pesan: PESAN_STATUS[baris.status],
      };
    },

    async daftar(filter: FilterSubmission, ctx: PortalContext): Promise<RingkasanSubmission[]> {
      wajibIzin(ctx, PERMISSION_PORTAL.LIHAT);
      const batas = Math.min(
        Math.max(1, filter.batasBaris ?? BATAS_BARIS_BAWAAN),
        BATAS_BARIS_MAKS,
      );
      const rows = await repo.daftar(deps.db, {
        bumnId: ctx.bumnId,
        jenis: filter.jenis ?? null,
        status: filter.status ?? null,
        noTiket: filter.noTiket ? filter.noTiket.trim().toUpperCase() : null,
        batas,
      });
      return rows.map(ringkasan);
    },

    async detail(id: string, ctx: PortalContext): Promise<DetailSubmission> {
      wajibIzin(ctx, PERMISSION_PORTAL.LIHAT);
      const baris = await repo.submissionById(deps.db, ctx.bumnId, id);
      if (!baris) throw tolak("SUBMISSION_TIDAK_DITEMUKAN", { submissionId: id });
      return detailDari(baris);
    },

    async tindak(id: string, input: TindakInput, ctx: PortalContext): Promise<DetailSubmission> {
      wajibIzin(ctx, PERMISSION_PORTAL.TINDAK);
      if (input.tindakan !== "DIPROSES" && input.tindakan !== "DITOLAK") {
        // `DIKONVERSI` is deliberately unreachable from this engine: the
        // status is a CLAIM that a proposal exists, and only
        // `pumk.konversiSubmissionPortal` can make that claim true.
        throw tolak("STATUS_TIDAK_BISA_DIUBAH", { tindakan: input.tindakan });
      }
      const catatan =
        typeof input.catatan === "string" && input.catatan.trim().length > 0
          ? input.catatan.trim().slice(0, 1000)
          : null;

      return deps.db.transaction(async (tx) => {
        const sebelum = await repo.submissionById(tx, ctx.bumnId, id);
        if (!sebelum) throw tolak("SUBMISSION_TIDAK_DITEMUKAN", { submissionId: id });
        if (sebelum.status === "DIKONVERSI" || sebelum.converted_proposal_id !== null) {
          throw tolak("SUBMISSION_SUDAH_DIKONVERSI", { submissionId: id });
        }
        const n = await repo.tandai(tx, {
          id,
          bumnId: ctx.bumnId,
          status: input.tindakan,
          catatan,
          userId: ctx.userId,
        });
        if (n === 0) throw tolak("SUBMISSION_SUDAH_DIKONVERSI", { submissionId: id });

        await deps.audit.record(
          {
            userId: ctx.userId,
            aksi: "portal.tindak",
            entitas: "portal_submission",
            entitasId: id,
            nilaiBaru: { status: input.tindakan },
            hasil: "SUKSES",
            keterangan: `submission ditandai ${input.tindakan}`,
          },
          tx,
        );

        const sesudah = await repo.submissionById(tx, ctx.bumnId, id);
        if (!sesudah) throw tolak("SUBMISSION_TIDAK_DITEMUKAN", { submissionId: id });
        return detailDari(sesudah);
      });
    },
  };
}
