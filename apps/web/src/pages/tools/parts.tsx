// Pieces the two diagnostic screens of spec 9.6 are built from.
//
// FOUR RULES LIVE HERE, ONCE EACH.
//
//   THESE PAGES DIAGNOSE AND NEVER REPAIR. Every endpoint behind them is a
//   GET, the engine has no journal port and no transaction, and there is
//   deliberately no control on either screen that looks like it fixes
//   something. A broken row is fixed by the engine that owns it: a reversing
//   journal, a reschedule, a re-run of a closing step. A repair button here
//   would be a second way into the ledger, around `postingEvent`.
//
//   A PERMANENTLY GREEN ROW IS EXPLAINED, NOT LEFT MYSTERIOUS. Two of the nine
//   checks are also database constraints, so a failure cannot be committed at
//   all. The catalogue says which (`dijagaDatabase`), and the row says so on
//   the page rather than leaving an operator wondering why one check never
//   moves.
//
//   A CHECK A BRANCH FILTER CANNOT NARROW SAYS SO. `TANGGA_KOLEKTIBILITAS`
//   reads configuration that belongs to the whole entity, so its rows carry no
//   branch at all (`terikatCabang: false`). Without that sentence, a user who
//   filtered to one branch and still saw the same finding would reasonably
//   conclude the filter is broken.
//
//   MONEY GOES THROUGH packages/ui, and ABSENT IS NOT UNREADABLE. A fact whose
//   value is null prints "tidak ada", never the "tidak sah" marker: the marker
//   means "this arrived and could not be read", and putting it on a field that
//   was simply not sent teaches a reader to ignore it where it matters.
import {
  Icon,
  Panel,
  StatusBadge,
  formatCount,
  formatMoney,
  UNPARSEABLE,
} from "@krakatausteel/ui";
import type { BarisPemeriksaan, HasilPemeriksaan, KodePemeriksaan } from "../../api/tools";

// ---------------------------------------------------------------------------
// The nine checks, named the way an operator would name them
// ---------------------------------------------------------------------------

/**
 * The catalogue's own `nama` is the SEED's wording ("v_integritas_jurnal
 * (jurnal tidak balance / kurang baris)"), which names the artefact and is
 * exactly right in a log. On a page it is the invariant that has to be legible
 * first, so the title below is the invariant and the artefact is printed next
 * to it, unchanged, as the thing to open when a check goes red.
 */
export const JUDUL_PEMERIKSAAN: Record<KodePemeriksaan, string> = {
  JURNAL_TIDAK_BALANCE: "Setiap jurnal seimbang debit dan kredit",
  JADWAL_POKOK_TIDAK_COCOK: "Total pokok jadwal sama dengan pokok akad",
  SNAPSHOT_KOLEKTIBILITAS_GANDA: "Tidak ada snapshot kolektibilitas ganda",
  SUB_LEDGER_PIUTANG_TIDAK_COCOK: "Sub ledger piutang cocok dengan buku besar",
  TANGGA_KOLEKTIBILITAS: "Tangga hari kolektibilitas tanpa celah dan tumpang tindih",
  JURNAL_DRAFT_DI_PERIODE_CLOSED: "Tidak ada jurnal draft pada periode tertutup",
  OUTSTANDING_POKOK_NEGATIF: "Tidak ada akad dengan outstanding pokok negatif",
  PIUTANG_JASA_BERSALDO_KREDIT: "Piutang Jasa Administrasi tidak pernah bersaldo kredit",
  NERACA_SALDO_TIDAK_SEIMBANG: "Buku besar seimbang antara debit dan kredit",
};

/** What the count on a row counts, so "3" is never a bare number. */
export const SATUAN_TEMUAN: Record<KodePemeriksaan, string> = {
  JURNAL_TIDAK_BALANCE: "jurnal bermasalah",
  JADWAL_POKOK_TIDAK_COCOK: "akad bermasalah",
  SNAPSHOT_KOLEKTIBILITAS_GANDA: "pasangan periode dan akad",
  SUB_LEDGER_PIUTANG_TIDAK_COCOK: "akad selisih",
  TANGGA_KOLEKTIBILITAS: "sambungan salah",
  JURNAL_DRAFT_DI_PERIODE_CLOSED: "jurnal draft",
  OUTSTANDING_POKOK_NEGATIF: "akad bersaldo negatif",
  PIUTANG_JASA_BERSALDO_KREDIT: "bulan bersaldo kredit",
  NERACA_SALDO_TIDAK_SEIMBANG: "temuan ketidakseimbangan",
};

export const CATATAN_DIJAGA_DATABASE =
  "Pemeriksaan ini juga dijaga constraint database, jadi barisnya memang diharapkan selalu lolos. Tetap ditampilkan sebagai pertahanan berlapis, supaya invarian yang sama tetap terpantau bila suatu saat constraint itu dilonggarkan oleh migrasi.";

export const CATATAN_TANPA_CABANG =
  "Baris pemeriksaan ini tidak memiliki cabang, karena tangga kolektibilitas adalah konfigurasi milik seluruh entitas. Filter cabang di atas tidak mempersempit hasilnya, dan itu bukan filter yang gagal bekerja.";

// ---------------------------------------------------------------------------
// Facts on an offending row
// ---------------------------------------------------------------------------

const POLA_DESIMAL = /^-?\d+(\.\d{1,2})?$/;
const KUNCI_UANG =
  /(saldo|selisih|total|pokok|jasa|nilai|debit|kredit|outstanding|disalurkan)/i;

/**
 * One fact, rendered as an operator reads it.
 *
 * A null value is ABSENT and prints "tidak ada". It never goes through
 * `formatMoney`, which would print the "tidak sah" marker on a field that is
 * legitimately empty, and once that marker appears where it does not belong a
 * reader stops trusting it where it does.
 */
export function nilaiFakta(kunci: string, nilai: string | null): string {
  if (nilai === null) return "tidak ada";
  if (KUNCI_UANG.test(kunci) && POLA_DESIMAL.test(nilai)) {
    return formatMoney(nilai, { parenthesizeNegative: true });
  }
  return nilai;
}

/** A raw `Uang` on these pages. Zero prints 0,00, unreadable prints the marker. */
export function teksUang(nilai: string | null | undefined): string {
  if (typeof nilai !== "string" || !POLA_DESIMAL.test(nilai)) return UNPARSEABLE;
  return formatMoney(nilai, { parenthesizeNegative: true });
}

export function teksBaris(baris: BarisPemeriksaan): string {
  const fakta = Object.entries(baris.fakta)
    .map(([kunci, nilai]) => `${kunci} ${nilaiFakta(kunci, nilai)}`)
    .join(", ");
  return fakta === ""
    ? `${baris.label}, id ${baris.id}`
    : `${baris.label}, id ${baris.id}, ${fakta}`;
}

// ---------------------------------------------------------------------------
// One check on the page
// ---------------------------------------------------------------------------

const BATAS_TAMPIL = 20;

/**
 * ONE SHAPE FOR NINE ROWS, whatever a row is carrying.
 *
 * Number, title, verdict badge, the engine's own one line summary, then the
 * count on a pinned foot rule and the offending rows underneath. The badge is
 * pinned to the end of the title row and never wraps, so a short title and a
 * long one produce the same row, which is what keeps nine checks reading as one
 * list instead of as nine designs.
 */
export function ItemPemeriksaan({ hasil }: { hasil: HasilPemeriksaan }) {
  const catatan: string[] = [];
  if (hasil.dijagaDatabase) catatan.push(CATATAN_DIJAGA_DATABASE);
  if (!hasil.terikatCabang) catatan.push(CATATAN_TANPA_CABANG);

  return (
    <li className={`prasyarat-item ${hasil.lulus ? "is-pass" : "is-gagal"}`}>
      <div className="prasyarat-head">
        <span className="prasyarat-nomor" aria-hidden="true">
          <Icon name={hasil.lulus ? "check" : "alert"} size={14} />
        </span>
        <span className="prasyarat-judul">
          {JUDUL_PEMERIKSAAN[hasil.kode] ?? hasil.kode}
        </span>
        <StatusBadge
          status={hasil.lulus ? "LULUS" : "TEMUAN"}
          tone={hasil.lulus ? "success" : "danger"}
          label={hasil.lulus ? "Lolos" : "Ada temuan"}
        />
      </div>
      <p className="prasyarat-alasan">
        Ringkasan mesin: {hasil.detail}. Dibaca dari {hasil.sumber}, baris yang dilaporkan berupa{" "}
        {hasil.entitas}.
      </p>
      {catatan.map((teks) => (
        <p className="prasyarat-alasan is-catatan" key={teks}>
          {teks}
        </p>
      ))}
      <div className="prasyarat-foot">
        <span className="prasyarat-angka-label">{SATUAN_TEMUAN[hasil.kode] ?? "temuan"}</span>
        <span className="prasyarat-angka-val">{formatCount(hasil.jumlah)}</span>
      </div>
      {hasil.baris.length === 0 ? null : (
        <ul className="prasyarat-rincian">
          {hasil.baris.slice(0, BATAS_TAMPIL).map((baris) => (
            <li className="prasyarat-rincian-item" key={`${baris.entitas}:${baris.id}`}>
              {teksBaris(baris)}
            </li>
          ))}
          {hasil.baris.length > BATAS_TAMPIL ? (
            <li className="prasyarat-rincian-item">
              dan {formatCount(hasil.baris.length - BATAS_TAMPIL)} baris lain pada halaman ini
            </li>
          ) : null}
          {hasil.terpotong ? (
            <li className="prasyarat-rincian-item">
              Daftar dipotong server: {formatCount(hasil.jumlah)} baris cocok, hanya sebagian yang
              dikirim.
            </li>
          ) : null}
        </ul>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Small shared cards
// ---------------------------------------------------------------------------

/**
 * One headline figure, in the same card shape the dashboard uses, so a KPI band
 * on a diagnostic page and a KPI band on the landing page are one design.
 */
export function KartuRingkas({
  judul,
  nilai,
  catatan,
}: {
  judul: string;
  nilai: string;
  catatan: string;
}) {
  return (
    <Panel as="h2" title={judul} className="panel-kpi metrik-kartu">
      <p className="metrik-nilai">{nilai}</p>
      <p className="metrik-catatan">{catatan}</p>
    </Panel>
  );
}

/** The note both diagnostic pages carry, in the same words, in one place. */
export function CatatanDiagnosa() {
  return (
    <p className="page-note">
      <Icon name="info" size={16} />
      <span>
        Halaman ini hanya memeriksa dan melaporkan. Tidak ada tombol perbaikan di sini: temuan
        diperbaiki di modul yang memiliki datanya, misalnya lewat jurnal koreksi, reschedule, atau
        pengulangan langkah closing, supaya seluruh perubahan tetap melewati jalur pencatatan yang
        sah.
      </span>
    </p>
  );
}
