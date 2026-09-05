// Pieces the four STAFF portal screens of spec 9.5 are built from.
//
// THESE ARE NOT ../../portal/. That folder is the PUBLIC surface: no session,
// no cookie, its own rate limits, mounted before the staff app is even
// constructed (see App.tsx's `Permukaan`). Everything here runs on a staff
// session and is gated by `portal.view` or `portal.konversi`. ADR 0019 keeps
// the three principals apart at every level the server has, and a shared
// component between the two would be the place they quietly rejoin.
//
// THE APPLICANT'S FORM IS RENDERED THROUGH THE SERVER'S OWN FIELD RULES, not
// through a copy of them. `aturanFormulir` names every key the public form may
// send and what each key IS, so `jumlah_diajukan` prints through the money
// formatter and `tenor_diajukan` prints as a count. Guessing by key name is how
// a tenor of 24 months becomes "Rp 24,00" on an officer's screen.
//
// AND AN ABSENT FIELD PRINTS WORDS, NEVER THE MONEY MARKER. `formulir` is a
// jsonb object whose optional keys are legitimately missing; sending a missing
// key through `formatMoney` would print "tidak sah" on a submission that is
// perfectly fine, and once that marker appears where it does not belong a
// reader stops trusting it where it does.
import type { ReactNode } from "react";
import {
  Icon,
  Panel,
  StatusBadge,
  formatCount,
  formatDate,
  formatMoney,
  type BadgeTone,
} from "@krakatausteel/ui";
import {
  aturanFormulir,
  type AturanField,
} from "@krakatausteel/api/src/modules/portal/contract";
import {
  LABEL_STATUS_SUBMISSION,
  type DetailSubmission,
  type JenisPengajuan,
  type RingkasanSubmission,
} from "../../api/portal-staf";
import type { ColumnSpec, KartuBaris } from "../shared/parts";

const TONE_STATUS: Record<string, BadgeTone> = {
  BARU: "info",
  DIPROSES: "progress",
  DIKONVERSI: "success",
  DITOLAK: "danger",
};

export function BadgeSubmission({ status }: { status: string }) {
  return (
    <StatusBadge
      status={status}
      tone={TONE_STATUS[status] ?? "neutral"}
      label={LABEL_STATUS_SUBMISSION[status] ?? status}
    />
  );
}

export const LABEL_JENIS_PENGAJUAN: Record<string, string> = {
  PUMK: "Pendanaan UMK",
  NON_PUMK: "Non PUMK",
};

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export function kolomSubmission(): readonly ColumnSpec<RingkasanSubmission>[] {
  return [
    { key: "noTiket", header: "Nomor tiket", sortable: true, width: "200px" },
    { key: "tanggalSubmit", header: "Masuk", type: "date", sortable: true, width: "120px" },
    {
      key: "namaPemohon",
      header: "Pemohon",
      render: (row) => row.namaPemohon ?? "tidak diisi pemohon",
    },
    {
      key: "kontak",
      header: "Kontak",
      width: "220px",
      render: (row) =>
        row.emailKontak ?? row.teleponKontak ?? "tidak diisi pemohon",
    },
    {
      key: "jumlahDiajukan",
      header: "Diajukan",
      width: "160px",
      type: "money",
      // ABSENT IS WORDS. `jumlahDiajukan` is null when the applicant left the
      // amount out, and a null through the money formatter would print the
      // "tidak sah" marker on a row that is perfectly fine.
      render: (row) =>
        row.jumlahDiajukan === null ? "tidak diisi" : formatMoney(row.jumlahDiajukan),
    },
    {
      key: "status",
      header: "Status",
      width: "170px",
      render: (row) => <BadgeSubmission status={row.status} />,
    },
  ];
}

export function kartuSubmission(row: RingkasanSubmission): KartuBaris {
  return {
    judul: row.noTiket,
    sub: `${row.namaPemohon ?? "pemohon tanpa nama"} . ${formatDate(row.tanggalSubmit)}`,
    meta: row.emailKontak ?? row.teleponKontak ?? "tanpa kontak",
    nilai: row.jumlahDiajukan === null ? undefined : formatMoney(row.jumlahDiajukan),
    nilaiLabel: "Diajukan",
    status: <BadgeSubmission status={row.status} />,
  };
}

// ---------------------------------------------------------------------------
// One submission, opened
// ---------------------------------------------------------------------------

const NAMA_FIELD: Record<string, string> = {
  nama_lengkap: "Nama lengkap",
  nama_usaha: "Nama usaha",
  sektor: "Sektor usaha",
  alamat: "Alamat",
  jumlah_diajukan: "Jumlah diajukan",
  tenor_diajukan: "Tenor diajukan, bulan",
  tujuan_penggunaan: "Tujuan penggunaan",
  nama_pemohon: "Nama pemohon",
  nama_lembaga: "Nama lembaga",
  judul_program: "Judul program",
  penerima_manfaat_estimasi: "Estimasi penerima manfaat",
  deskripsi: "Deskripsi program",
};

const NAMA_DOKUMEN: Record<string, string> = {
  KTP: "KTP",
  KK: "Kartu Keluarga",
  NPWP: "NPWP",
  SIUP: "SIUP",
  NIB: "NIB",
  FOTO_USAHA: "Foto usaha",
  SURAT_KETERANGAN_USAHA: "Surat keterangan usaha",
  LAINNYA: "Dokumen lain",
};

/**
 * One value of the applicant's form, rendered as its RULE says it should be.
 *
 * Money through the money formatter, a count through the count formatter, text
 * as text. An absent optional key prints "tidak diisi pemohon", which is a fact
 * about the submission and not a failure of this page.
 */
function nilaiFormulir(aturan: AturanField | undefined, nilai: unknown): string {
  if (nilai === null || nilai === undefined || nilai === "") return "tidak diisi pemohon";
  if (aturan?.jenis === "uang") {
    return typeof nilai === "string" || typeof nilai === "number"
      ? formatMoney(nilai)
      : String(nilai);
  }
  if (aturan?.jenis === "bulat") {
    return typeof nilai === "number" || typeof nilai === "string"
      ? formatCount(nilai)
      : String(nilai);
  }
  return String(nilai);
}

export function FormulirPemohon({ submission }: { submission: DetailSubmission }) {
  const aturan = aturanFormulir(submission.jenis as JenisPengajuan);
  const kunci = Object.keys(aturan);
  return (
    <dl className="fakta-grid">
      {kunci.map((key) => (
        <div className="fakta-item" key={key}>
          <dt className="fakta-key">{NAMA_FIELD[key] ?? key}</dt>
          <dd className="fakta-val">{nilaiFormulir(aturan[key], submission.formulir[key])}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The documents the applicant DECLARED.
 *
 * The public endpoint records that a document was offered and does not accept
 * bytes, so there is nothing to open here and the page says so instead of
 * drawing a download control that would answer nothing.
 */
export function DokumenPemohon({ submission }: { submission: DetailSubmission }) {
  if (submission.dokumen.length === 0) {
    return (
      <p className="periksa-item">
        <Icon name="alert" size={16} />
        <span>
          Pemohon tidak menyebutkan satu dokumen pun. Kelengkapan berkas diminta di luar sistem
          sebelum submission ini dikonversi menjadi proposal.
        </span>
      </p>
    );
  }
  return (
    <>
      <ul className="pilihan-list">
        {submission.dokumen.map((dokumen, index) => (
          <li className="pilihan-btn is-statis" key={`${dokumen.jenis}-${index}`}>
            <span className="pilihan-judul">{NAMA_DOKUMEN[dokumen.jenis] ?? dokumen.jenis}</span>
            <span className="pilihan-sub">{dokumen.namaFile}</span>
          </li>
        ))}
      </ul>
      <p className="page-note">
        <Icon name="info" size={16} />
        <span>
          Portal publik hanya mencatat nama berkas yang disebut pemohon, tidak menerima unggahan
          berkasnya. Karena itu tidak ada tautan unduh di sini, dan berkas fisiknya diminta terpisah.
        </span>
      </p>
    </>
  );
}

/** The header facts of one submission, in one shape on all three screens. */
export function RingkasSubmission({ submission }: { submission: DetailSubmission }) {
  const fakta: readonly { label: string; nilai: ReactNode }[] = [
    { label: "Nomor tiket", nilai: submission.noTiket },
    { label: "Jenis pengajuan", nilai: LABEL_JENIS_PENGAJUAN[submission.jenis] ?? submission.jenis },
    { label: "Tanggal masuk", nilai: formatDate(submission.tanggalSubmit) },
    { label: "Email kontak", nilai: submission.emailKontak ?? "tidak diisi pemohon" },
    { label: "Telepon kontak", nilai: submission.teleponKontak ?? "tidak diisi pemohon" },
    {
      label: "Jumlah diajukan",
      nilai:
        submission.jumlahDiajukan === null
          ? "tidak diisi pemohon"
          : formatMoney(submission.jumlahDiajukan),
    },
    { label: "Catatan petugas", nilai: submission.catatanPetugas ?? "belum ada catatan" },
    {
      label: "Proposal hasil konversi",
      nilai: submission.convertedProposalId ?? "belum dikonversi",
    },
  ];
  return (
    <dl className="fakta-grid">
      {fakta.map((item) => (
        <div className="fakta-item" key={item.label}>
          <dt className="fakta-key">{item.label}</dt>
          <dd className="fakta-val">{item.nilai}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One submission, opened: facts, the applicant's own form, the documents. */
export function DokumenSubmission({
  submission,
  aksi,
}: {
  submission: DetailSubmission;
  aksi?: ReactNode;
}) {
  return (
    <Panel
      as="h2"
      title={`Submission ${submission.noTiket}`}
      description="Data yang diisi pemohon sendiri di portal publik, apa adanya, tanpa perubahan."
      aside={<BadgeSubmission status={submission.status} />}
      footer={
        <span className="panel-foot-note">
          Sumber: GET /api/portal/submission/{submission.id}. Kewenangan portal.view.
        </span>
      }
    >
      <RingkasSubmission submission={submission} />
      <h3 className="sub-judul">Isian formulir pemohon</h3>
      <FormulirPemohon submission={submission} />
      <h3 className="sub-judul">Dokumen yang disebut pemohon</h3>
      <DokumenPemohon submission={submission} />
      {aksi ? <div className="form-actions-row">{aksi}</div> : null}
    </Panel>
  );
}

/** The note every staff portal screen carries about the public surface. */
export function CatatanPortal() {
  return (
    <p className="page-note">
      <Icon name="info" size={16} />
      <span>
        Halaman ini adalah sisi petugas. Formulir publiknya berjalan tanpa sesi, dengan pembatasan
        laju tersendiri, dan pemohon memeriksa statusnya sendiri memakai nomor tiket ditambah NIK
        atau tanggal lahir. Tidak ada data sesi petugas yang tersentuh dari sisi publik itu.
      </span>
    </p>
  );
}
