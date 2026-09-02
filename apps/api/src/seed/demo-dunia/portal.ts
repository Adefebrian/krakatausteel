// Portal pengajuan online (spec 9.5): 25 submissions in every state.
//
// The rows are written directly because the public portal's intake endpoint is
// not built and no module owns a create path for `portal_submission`; it is not
// a ledger table and nothing is bypassed. The one state that DOES have an
// engine path, DIKONVERSI, is never set here: those submissions are handed to
// `pumk.konversiSubmissionPortal`, which is what writes
// `converted_proposal_id`, flips the status and copies the form data. Setting
// it by hand would produce a submission that claims a proposal it never made.
import type { Dunia } from "./dunia";
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
    const noTiket = `TKT-${p.tahun}${p.bulan.toString().padStart(2, "0")}-${(i + 1)
      .toString()
      .padStart(3, "0")}`;
    const data =
      jenis === "PUMK"
        ? {
            nama_lengkap: nama,
            nama_usaha: `${d.pilih(usaha.nama)} ${nama.split(" ")[0]}`,
            sektor: usaha.sektor,
            jumlah_diajukan: `${pokokWajar(d)}.00`,
            tenor_diajukan: d.pilih([12, 18, 24]),
            tujuan_penggunaan: "Tambahan modal kerja",
            alamat: "Kp. Ciwaduk RT 03/RW 02",
          }
        : {
            nama_pemohon: nama,
            judul_program: "Bantuan sarana umum lingkungan",
            jumlah_diajukan: `${d.int(15, 90) * 1_000_000}.00`,
            penerima_manfaat_estimasi: d.int(40, 400),
          };

    const rows = await dunia.db.query<{ id: string }>(
      `INSERT INTO portal_submission
         (bumn_id, jenis, no_tiket, tanggal_submit, data_json, dokumen_json,
          email_kontak, telepon_kontak, status, ip_submitter, user_agent, catatan_petugas)
       VALUES ($1::uuid, $2, $3, $4::timestamptz, $5::text::jsonb, $6::text::jsonb,
               $7, $8, $9, $10::inet, $11, $12)
       ON CONFLICT (no_tiket) DO UPDATE SET data_json = EXCLUDED.data_json
       RETURNING id::text AS id`,
      [
        dunia.bumnId,
        jenis,
        noTiket,
        `${tgl}T03:${(i % 60).toString().padStart(2, "0")}:00Z`,
        JSON.stringify(data),
        JSON.stringify([
          { jenis: "KTP", nama_file: "ktp.jpg" },
          { jenis: "SURAT_KETERANGAN_USAHA", nama_file: "sku.pdf" },
        ]),
        `${nama.split(" ")[0]?.toLowerCase()}${i}@contoh.local`,
        `08${d.int(11, 89)}${d.int(1000000, 9999999)}`,
        s === "PENDING_KONVERSI" ? "DIPROSES" : s,
        `10.30.${d.int(0, 254)}.${d.int(1, 254)}`,
        "Mozilla/5.0 (Linux; Android 13) portal-tjsl",
        s === "DITOLAK"
          ? "Berkas tidak lengkap dan tidak ditindaklanjuti dalam 14 hari"
          : s === "DIPROSES"
            ? "Sedang diverifikasi petugas cabang"
            : null,
      ],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error(`seed demo: submission ${noTiket} gagal dibuat`);
    const entri = { id, noTiket, status: s };
    semua.push(entri);
    if (s === "PENDING_KONVERSI") untukKonversi.push(entri);
  }
  return { semua, untukKonversi };
}
