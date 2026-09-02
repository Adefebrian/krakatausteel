// Pieces the dashboard is built from, so the eleven metric cards, the two
// panels and the drill-down dialog cannot drift into three different opinions
// about the same month.
//
// FOUR RULES LIVE HERE, ONCE EACH.
//
//   EVERY FIGURE NAMES THE ARTEFACT THAT ANSWERED IT. `Metrik.sumber` is
//   `SALDO_AKUN_PERIODE` (a closed month's frozen trial balance),
//   `KOLEKTIBILITAS_SNAPSHOT`, `V_LEDGER_BARIS` (an open month's live ledger),
//   `SUB_LEDGER`, `RKA` or `PROSES`, and the card says which. That is not
//   decoration: a closed month read frozen and an open month read live are what
//   make this page agree with the statements, and somebody comparing two months
//   has no other way to see the difference.
//
//   ABSENT IS NOT ZERO. `nilai: null` arrives with one of eight reasons and the
//   card prints the reason. A zero on a dashboard is a statement of fact
//   ("nothing happened"); every one of those reasons is "this system cannot
//   answer that today", which is a different sentence entirely.
//
//   AND ABSENT IS NOT UNREADABLE. A null figure never reaches `formatMoney`.
//   The formatter renders an unparseable value as the visible marker "tidak
//   sah", and printing that marker on a row that is perfectly fine is how a
//   reader stops trusting it on the row where it matters. `teksMetrik` and
//   `teksNilaiRincian` both branch on absence BEFORE formatting.
//
//   EVERY NUMBER IS DRILLABLE, OR IT CARRIES NO LINK AT ALL. Spec 11: an
//   untraceable figure is not believed. So a card with a value offers the rows
//   behind it, and a card without one offers nothing rather than a link that
//   would answer with an empty list.
import { useState, type ReactNode } from "react";
import {
  Button,
  DataTable,
  Icon,
  Modal,
  Panel,
  StatusBadge,
  formatCount,
  formatDate,
  formatMoney,
  UNPARSEABLE,
  type Column,
} from "@krakatausteel/ui";
import {
  rincianDashboard,
  type AlasanKosong,
  type BarisRincian,
  type JenisAngka,
  type Metrik,
  type SumberAngka,
} from "../../api/dashboard";
import { useApi } from "../../api/useApi";

// ---------------------------------------------------------------------------
// Where a number came from
// ---------------------------------------------------------------------------

/** The short name of an artefact, for the line under a figure. */
export const LABEL_SUMBER: Record<SumberAngka, string> = {
  SALDO_AKUN_PERIODE: "Saldo beku periode tertutup",
  KOLEKTIBILITAS_SNAPSHOT: "Snapshot kolektibilitas periode tertutup",
  V_LEDGER_BARIS: "Ledger berjalan periode terbuka",
  SUB_LEDGER: "Sub ledger PUMK berjalan",
  RKA: "Baseline RKA yang disetujui",
  PROSES: "Cacah dokumen yang sedang berproses",
};

/** The same claim spelled out, for the dialog and for the page level note. */
export const JELAS_SUMBER: Record<SumberAngka, string> = {
  SALDO_AKUN_PERIODE:
    "Dibaca dari saldo akun yang dibekukan saat closing, jadi angka ini sama persis dengan laporan periode tersebut dan tidak berubah lagi.",
  KOLEKTIBILITAS_SNAPSHOT:
    "Dibaca dari snapshot kolektibilitas periode tertutup, bukan dihitung ulang, jadi angkanya sama dengan yang dipakai saat closing.",
  V_LEDGER_BARIS:
    "Dihitung langsung dari ledger periode berjalan, jadi angkanya masih bisa berubah selama masih ada jurnal yang masuk.",
  SUB_LEDGER:
    "Dibaca langsung dari data akad, jadwal, dan angsuran PUMK yang berlaku saat ini.",
  RKA: "Dibaca dari baseline RKA yang berlaku untuk tahun ini, versi yang sudah disetujui.",
  PROSES: "Cacah dokumen yang sedang menunggu tindakan, bukan angka akuntansi.",
};

// ---------------------------------------------------------------------------
// Why a number is absent
// ---------------------------------------------------------------------------

/** The short reason, printed in place of the figure. Never a zero. */
export const LABEL_ALASAN: Record<AlasanKosong, string> = {
  IZIN_TIDAK_DIMILIKI: "Tidak ditampilkan",
  SALDO_PERIODE_BELUM_DIBEKUKAN: "Saldo periode belum dibekukan",
  KOLEKTIBILITAS_BELUM_DIJALANKAN: "Kolektibilitas belum dijalankan",
  BASELINE_RKA_TIDAK_ADA: "Baseline RKA belum ada",
  ANGGARAN_TIDAK_PER_BULAN: "Anggaran tidak dirinci per bulan",
  PEMBAGI_NOL: "Pembagi bernilai nol",
  PEMETAAN_AKUN_BELUM_ADA: "Pemetaan akun belum ada",
  SUMBER_TIDAK_TERPASANG: "Sumber belum terpasang",
};

/** The reason as a sentence a reader can act on. */
export const JELAS_ALASAN: Record<AlasanKosong, string> = {
  IZIN_TIDAK_DIMILIKI:
    "Angka ini di balik kewenangan yang belum Anda miliki. Nol akan menyesatkan, karena nilainya belum tentu nol.",
  SALDO_PERIODE_BELUM_DIBEKUKAN:
    "Periode tertutup tetapi saldonya belum dibekukan, jadi tidak ada angka beku yang bisa dibaca.",
  KOLEKTIBILITAS_BELUM_DIJALANKAN:
    "Closing kolektibilitas belum dijalankan, jadi klasifikasi piutang periode ini memang belum ada.",
  BASELINE_RKA_TIDAK_ADA:
    "Tidak ada versi RKA disetujui untuk lingkup dan tahun ini, jadi tidak ada anggaran pembanding.",
  ANGGARAN_TIDAK_PER_BULAN:
    "Baseline RKA tidak merinci anggaran per bulan, jadi tidak ada angka bulan ini yang bisa dibaca.",
  PEMBAGI_NOL:
    "Pembagi rasio ini bernilai nol pada periode terpilih, jadi rasionya tidak terdefinisi.",
  PEMETAAN_AKUN_BELUM_ADA:
    "Pemetaan akun untuk peristiwa yang mendasari angka ini belum diatur di konfigurasi.",
  SUMBER_TIDAK_TERPASANG:
    "Modul yang memiliki definisi angka ini belum terpasang di server, jadi angkanya tidak dapat diminta.",
};

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

const POLA_DESIMAL = /^-?\d+(\.\d{1,2})?$/;
const POLA_CACAH = /^-?\d+$/;

/**
 * One metric's figure as text.
 *
 * Three outcomes, never two: a figure, an ABSENT figure (which is the reason,
 * and never "tidak sah"), and a figure that arrived MALFORMED (which is the
 * marker, and never a zero). The first branch is the one the closing screens
 * got wrong once: sending an absent value through the money formatter prints
 * the marker on a row that is perfectly fine.
 */
export function teksMetrik(metrik: Metrik): { teks: string; kelas: string } {
  if (metrik.nilai === null) {
    const alasan = metrik.alasanKosong;
    return {
      teks: alasan ? LABEL_ALASAN[alasan] : "Tidak tersedia",
      kelas: "metrik-nilai is-kosong",
    };
  }
  return { teks: teksAngka(metrik.jenis, metrik.nilai), kelas: "metrik-nilai" };
}

/** A present figure, formatted per its kind. Money never formatted by hand. */
export function teksAngka(jenis: JenisAngka, nilai: string): string {
  if (jenis === "CACAH") {
    return POLA_CACAH.test(nilai) ? formatCount(nilai) : UNPARSEABLE;
  }
  if (!POLA_DESIMAL.test(nilai)) return UNPARSEABLE;
  if (jenis === "PERSEN") return `${formatMoney(nilai, { decimals: 2 })}%`;
  return formatMoney(nilai, { parenthesizeNegative: true });
}

/**
 * A drill-down row's contribution. `nilai` is null for every metric that
 * counts documents rather than money, and that is ABSENCE, not corruption: the
 * row says so in words instead of printing the marker.
 */
export function teksNilaiRincian(nilai: string | null): string {
  if (nilai === null) return "Tanpa nilai uang";
  return POLA_DESIMAL.test(nilai)
    ? formatMoney(nilai, { parenthesizeNegative: true })
    : UNPARSEABLE;
}

/** A percentage that may legitimately not exist. Null is not zero. */
export function teksPersen(nilai: string | null): string {
  if (nilai === null) return "Tidak dapat dihitung";
  return POLA_DESIMAL.test(nilai) ? `${formatMoney(nilai, { decimals: 2 })}%` : UNPARSEABLE;
}

/** A raw `Uang` on this page. Zero prints 0,00, an unreadable value the marker. */
export function teksUang(nilai: string | null | undefined): string {
  if (typeof nilai !== "string" || !POLA_DESIMAL.test(nilai)) return UNPARSEABLE;
  return formatMoney(nilai, { parenthesizeNegative: true });
}

// ---------------------------------------------------------------------------
// A metric card
// ---------------------------------------------------------------------------

/**
 * ONE SHAPE FOR ELEVEN CARDS, whatever a card is carrying.
 *
 * Title, figure, one note line, one footer. The note line is the artefact when
 * there is a figure and the reason when there is not, so a card that cannot
 * answer is the same height as one that can and a row of four never reads as
 * four different designs. The footer is pinned to one baseline by `.panel-foot`
 * and is always present: a drill-down control when there are rows behind the
 * figure, and a plain sentence when there are not.
 */
export function KartuMetrik({
  metrik,
  catatanSumber,
  onRincian,
}: {
  metrik: Metrik;
  /**
   * An override for the note line, used for the one metric whose source
   * disagrees with the period's own. See the collection ratio on Dashboard.tsx.
   */
  catatanSumber?: string;
  onRincian: (kunci: string, nama: string) => void;
}) {
  const angka = teksMetrik(metrik);
  const catatan =
    catatanSumber ??
    (metrik.nilai === null
      ? metrik.alasanKosong
        ? JELAS_ALASAN[metrik.alasanKosong]
        : "Angka ini tidak dapat dijawab untuk periode terpilih."
      : metrik.sumber
        ? LABEL_SUMBER[metrik.sumber]
        : "Sumber angka tidak dinyatakan.");

  return (
    <Panel
      as="h2"
      title={metrik.nama}
      className="panel-kpi metrik-kartu"
      footer={
        metrik.rincian === null ? (
          <span className="metrik-tanpa-rincian">Tidak ada baris yang bisa ditelusuri</span>
        ) : (
          <button
            type="button"
            className="metrik-drill"
            onClick={() => onRincian(metrik.rincian as string, metrik.nama)}
          >
            <span>Lihat baris di balik angka</span>
            <Icon name="chevronRight" size={16} />
          </button>
        )
      }
    >
      <p className={angka.kelas}>{angka.teks}</p>
      <p className="metrik-catatan">{catatan}</p>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// The drill-down
// ---------------------------------------------------------------------------

export interface PermintaanRincian {
  kunci: string;
  nama: string;
}

/** The facts a row carries, as one line. Long ones are clamped, never wrapped
 *  onto a second line, so ten rows keep one height. */
function teksFakta(fakta: Readonly<Record<string, string | null>>): string {
  return Object.entries(fakta)
    .map(([kunci, nilai]) => `${kunci}: ${nilai ?? "tidak ada"}`)
    .join(", ");
}

/**
 * FOUR COLUMNS, AND THE ID IS INSIDE THE FIRST ONE.
 *
 * The id is what makes a figure chaseable, so it is never dropped; it sits
 * under the label rather than in a fifth column, because a fixed width dialog
 * with five columns is how a table starts clipping its last one. `fakta` gets
 * the same treatment: one clamped line, with the whole of it in the title.
 */
const KOLOM_RINCIAN: readonly Column<BarisRincian>[] = [
  {
    key: "label",
    header: "Baris sumber",
    sortable: true,
    sortValue: (row) => row.label,
    render: (row) => (
      <span className="sel-utama is-lebar">
        <span className="sel-utama-judul">{row.label}</span>
        <span className="sel-utama-sub" title={teksFakta(row.fakta)}>
          {row.entitas} {row.id}
        </span>
      </span>
    ),
  },
  { key: "tanggal", header: "Tanggal", type: "date", sortable: true, width: "132px" },
  {
    key: "nilai",
    header: "Kontribusi",
    type: "money",
    sortable: true,
    width: "168px",
    sortValue: (row) => (row.nilai === null ? "" : Number(row.nilai)),
    render: (row) =>
      row.nilai === null ? (
        <span className="angka-kosong">Tanpa nilai uang</span>
      ) : (
        <span className="angka">{teksNilaiRincian(row.nilai)}</span>
      ),
  },
];

/**
 * The rows behind one number, in a dialog, so following a figure never loses
 * the page it was followed from.
 *
 * The rows carry their ids, which is the whole point: a figure a reader cannot
 * chase to a record is a figure a reader does not believe.
 */
export function DialogRincian({
  permintaan,
  periodeId,
  cabangId,
  onClose,
}: {
  permintaan: PermintaanRincian | null;
  periodeId: string | null;
  cabangId: string | null;
  onClose: () => void;
}) {
  const hasil = useApi(
    () =>
      rincianDashboard(permintaan?.kunci ?? "", {
        periodeId,
        cabangId,
      }),
    [permintaan?.kunci, periodeId, cabangId],
    { enabled: permintaan !== null },
  );

  return (
    <Modal
      open={permintaan !== null}
      title={permintaan ? `Rincian ${permintaan.nama}` : "Rincian"}
      description="Baris sumber yang membentuk angka ini, lengkap dengan id catatannya."
      size="lg"
      onClose={onClose}
      actions={
        <Button variant="secondary" onClick={onClose}>
          Tutup
        </Button>
      }
    >
      {hasil.status === "memuat" ? (
        <p className="muat-memuat" role="status">
          Memuat rincian angka.
        </p>
      ) : hasil.status === "gagal" || hasil.data === null ? (
        <p className="form-error" role="alert">
          <Icon name="alert" size={16} />
          <span>{hasil.error ?? "Rincian tidak dapat dibaca dari GET /api/dashboard/rincian"}</span>
        </p>
      ) : (
        <div className="rincian-dialog">
          <dl className="rincian-fakta">
            <div className="rincian-fakta-baris">
              <dt>Sumber angka</dt>
              <dd>{LABEL_SUMBER[hasil.data.sumber] ?? hasil.data.sumber}</dd>
            </div>
            <div className="rincian-fakta-baris">
              <dt>Jumlah baris</dt>
              <dd>{formatCount(hasil.data.jumlah)}</dd>
            </div>
            <div className="rincian-fakta-baris">
              <dt>Total nilai</dt>
              <dd>
                {hasil.data.total === null
                  ? "Angka ini berupa cacah, tidak ada total uang"
                  : teksUang(hasil.data.total)}
              </dd>
            </div>
          </dl>
          <p className="rincian-jelas">{JELAS_SUMBER[hasil.data.sumber] ?? ""}</p>
          <div className="daftar-tabel">
            <DataTable
              columns={KOLOM_RINCIAN}
              rows={hasil.data.baris}
              rowKey={(row) => `${row.entitas}:${row.id}`}
              emptyTitle="Tidak ada baris sumber"
              emptyDescription="Angka ini tidak memiliki baris yang bisa ditampilkan pada lingkup terpilih."
            />
          </div>
          <div className="daftar-kartu">
            {hasil.data.baris.length === 0 ? (
              <p className="muat-diam">
                Angka ini tidak memiliki baris yang bisa ditampilkan pada lingkup terpilih.
              </p>
            ) : (
              <ul className="kartu-list">
                {hasil.data.baris.map((row) => (
                  <li className="kartu-item is-statis" key={`${row.entitas}:${row.id}`}>
                    <div className="rincian-kartu">
                      <span className="kartu-head">
                        <span className="kartu-judul">{row.label}</span>
                        <StatusBadge status={row.entitas} label={row.entitas} tone="neutral" />
                      </span>
                      <span className="kartu-sub" title={teksFakta(row.fakta)}>
                        {row.tanggal ? formatDate(row.tanggal) : "Tanpa tanggal"}, id {row.id}
                      </span>
                      <span className="kartu-foot">
                        <span className="kartu-meta">Kontribusi</span>
                        <span className="kartu-nilai-val">{teksNilaiRincian(row.nilai)}</span>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {hasil.data.terpotong ? (
            <p className="rincian-potong">
              Daftar dipotong. {formatCount(hasil.data.jumlah)} baris cocok, dan yang ditampilkan
              hanya sebagian.
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

/** The dialog plus the one piece of state it needs, wired once per page. */
export function useRincian(): {
  permintaan: PermintaanRincian | null;
  buka: (kunci: string, nama: string) => void;
  tutup: () => void;
} {
  const [permintaan, setPermintaan] = useState<PermintaanRincian | null>(null);
  return {
    permintaan,
    buka: (kunci, nama) => setPermintaan({ kunci, nama }),
    tutup: () => setPermintaan(null),
  };
}

/** A section heading at the same rhythm on every band of this page. */
export function Band({
  id,
  judul,
  catatan,
  children,
}: {
  id: string;
  judul: string;
  catatan: string;
  children: ReactNode;
}) {
  return (
    <section className="band" aria-labelledby={id}>
      <div className="band-head">
        <h2 className="band-title" id={id}>
          {judul}
        </h2>
        <p className="band-note">{catatan}</p>
      </div>
      {children}
    </section>
  );
}
