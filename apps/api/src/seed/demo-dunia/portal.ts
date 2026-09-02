// Portal pengajuan online (spec 9.5): 25 submissions in every state.
//
// THESE ROWS NOW GO THROUGH THE ENGINE. Until Fase 7 there was no create path
// for `portal_submission` at all, so this file inserted the rows directly and
// said so. There is one now (`modules/portal`), and a seed that keeps writing
// its own rows would be seeding a world the application could not have
// produced: it would bypass the field allowlist, the ticket generator, the
// verifier hashing, and the anti-spam counters, and it would go on passing
// after any of them broke.
//
// So every submission below is filed the way a member of the public files one
// (`portal.ajukan`, no session, allowlisted form data only), and every status
// move an officer makes is made the way an officer makes it (`portal.tindak`,
// under `portal.konversi`).
//
// TWO STATES ARE STILL NOT SET HERE, for two different reasons:
//   BARU        is what the engine produces. Nothing has to set it.
//   DIKONVERSI  is produced by `pumk.konversiSubmissionPortal`, which is the
//               only thing that can create the proposal that status claims
//               exists. `portal.tindak` cannot reach it and refuses to try.
import type { Dunia, KonteksDemo } from "./dunia";
import { BELAKANG, DEPAN_L, DEPAN_P, JENIS_USAHA, pokokWajar, tanggal, type Dadu } from "./acak";

export const JUMLAH_SUBMISSION = 25;

/** How many of the 25 sit in each state; DIKONVERSI is produced by the engine. */
export const SEBARAN_SUBMISSION = {
  BARU: 10,
  DIPROSES: 6,
  DITOLAK: 4,
  DIKONVERSI: 5,
} as const;

export interface SubmissionDemo {
  id: string;
  noTiket: string;
  status: string;
}

export interface HasilPortal {
  semua: SubmissionDemo[];
  /** Submissions waiting to be converted by the PUMK plan. */
  untukKonversi: SubmissionDemo[];
}

/** A NIK that is unique per submission, used as the status-check verifier. */
function nikDemo(i: number): string {
  return `3204${String(10 + (i % 80)).padStart(2, "0")}0101900${String(i).padStart(3, "0")}`.slice(
    0,
    16,
  );
}

export async function seedSubmissionPortal(dunia: Dunia, d: Dadu): Promise<HasilPortal> {
  const semua: SubmissionDemo[] = [];
  const untukKonversi: SubmissionDemo[] = [];
  const status: string[] = [
    ...Array<string>(SEBARAN_SUBMISSION.BARU).fill("BARU"),
    ...Array<string>(SEBARAN_SUBMISSION.DIPROSES).fill("DIPROSES"),
    ...Array<string>(SEBARAN_SUBMISSION.DITOLAK).fill("DITOLAK"),
    ...Array<string>(SEBARAN_SUBMISSION.DIKONVERSI).fill("PENDING_KONVERSI"),
  ];
  if (status.length !== JUMLAH_SUBMISSION) {
    throw new Error(`seed demo: sebaran submission berjumlah ${status.length}, bukan ${JUMLAH_SUBMISSION}`);
  }

  // The entity code is the PUBLIC selector the portal takes, exactly as a form
  // on the website would send it. It selects which entity receives the
  // application; it is never authority for anything.
  const entitas = await dunia.db.query<{ kode: string }>(
    `SELECT kode FROM bumn WHERE id = $1::uuid`,
    [dunia.bumnId],
  );
  const kodeEntitas = entitas[0]?.kode;
  if (!kodeEntitas) throw new Error("seed demo: BUMN demo tidak punya kode");

  // The officer who verifies and refuses. A branch Maker holds
  // `portal.konversi` on the shipped grant matrix, which is the same principal
  // that would do this from the screen.
  const petugas = Object.values(dunia.petugas)[0]?.maker;
  if (!petugas) throw new Error("seed demo: tidak ada petugas maker untuk antrean portal");
  const ctxPetugas: KonteksDemo = {
    userId: petugas.userId,
    cabangId: petugas.cabangId,
    bumnId: dunia.bumnId,
    permissions: petugas.permissions,
    cabangDalamScope: petugas.cabangDalamScope,
  };

  const akhir = dunia.periode[dunia.periode.length - 1]!;
  for (let i = 0; i < status.length; i += 1) {
    // Spread over the last six months: a portal queue is recent by nature.
    const p = dunia.periode[Math.max(0, dunia.periode.length - 1 - (i % 6))] ?? akhir;
    const tgl = tanggal(p.tahun, p.bulan, d.int(2, 26));
    const laki = d.peluang(0.5);
    const nama = `${laki ? d.pilih(DEPAN_L) : d.pilih(DEPAN_P)} ${d.pilih(BELAKANG)}`;
    const usaha = d.pilih(JENIS_USAHA);
    const s = status[i]!;
    // A submission earmarked for conversion is always PUMK: the conversion path
    // that exists (`pumk.konversiSubmissionPortal`) refuses anything else with
    // SUBMISSION_BUKAN_PUMK, and the Non PUMK side has no converter yet.
    const jenis = s !== "PENDING_KONVERSI" && i % 5 === 4 ? "NON_PUMK" : "PUMK";

    // The clock is the world's, so the queue carries real dates instead of
    // twenty five rows all stamped with the moment the seed ran.
    dunia.jam.ke(tgl);

    const formulir =
      jenis === "PUMK"
        ? {
            nama_lengkap: nama,
            nama_usaha: `${d.pilih(usaha.nama)} ${nama.split(" ")[0]}`,
            sektor: usaha.sektor,
            alamat: "Kp. Ciwaduk RT 03/RW 02",
            jumlah_diajukan: `${pokokWajar(d)}.00`,
            tenor_diajukan: d.pilih([12, 18, 24]),
            tujuan_penggunaan: "Tambahan modal kerja",
          }
        : {
            nama_pemohon: nama,
            judul_program: "Bantuan sarana umum lingkungan",
            alamat: "Kp. Ciwaduk RT 03/RW 02",
            jumlah_diajukan: `${d.int(15, 90) * 1_000_000}.00`,
            penerima_manfaat_estimasi: d.int(40, 400),
            deskripsi: "Perbaikan sarana umum di lingkungan sekitar perusahaan.",
          };

    // ANONYMOUS, exactly as the public files it: no session, no user id, just
    // an address and a user agent.
    const hasil = await dunia.portal.ajukan(
      {
        kodeEntitas,
        jenis,
        emailKontak: `${nama.split(" ")[0]?.toLowerCase()}${i}@contoh.local`,
        teleponKontak: `08${d.int(11, 89)}${d.int(1000000, 9999999)}`,
        nik: nikDemo(i),
        formulir,
        dokumen: [
          { jenis: "KTP", namaFile: "ktp.jpg" },
          { jenis: "SURAT_KETERANGAN_USAHA", namaFile: "sku.pdf" },
        ],
      },
      {
        ip: `10.30.${d.int(0, 254)}.${d.int(1, 254)}`,
        userAgent: "Mozilla/5.0 (Linux; Android 13) portal-tjsl",
      },
    );

    // The id is resolved through the officer's own queue rather than by a
    // lookup of our own: `ajukan` deliberately answers the public with a
    // ticket number and nothing that could be used to reach the row again.
    const antrean = await dunia.portal.daftar({ noTiket: hasil.noTiket }, ctxPetugas);
    const baris = antrean[0];
    if (!baris) throw new Error(`seed demo: submission ${hasil.noTiket} tidak muncul di antrean`);

    // The officer's verification pass, through the officer's own route.
    if (s === "DIPROSES" || s === "PENDING_KONVERSI") {
      await dunia.portal.tindak(
        baris.id,
        { tindakan: "DIPROSES", catatan: "Sedang diverifikasi petugas cabang" },
        ctxPetugas,
      );
    } else if (s === "DITOLAK") {
      await dunia.portal.tindak(
        baris.id,
        {
          tindakan: "DITOLAK",
          catatan: "Berkas tidak lengkap dan tidak ditindaklanjuti dalam 14 hari",
        },
        ctxPetugas,
      );
    }

    const entri = { id: baris.id, noTiket: hasil.noTiket, status: s };
    semua.push(entri);
    if (s === "PENDING_KONVERSI") untukKonversi.push(entri);
  }
  return { semua, untukKonversi };
}
