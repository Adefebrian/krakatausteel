// Pieces every accounting report screen is built from, so the seven statements
// of spec 10.3 plus report 24 cannot drift into eight slightly different
// headers, eight filter rows and eight opinions about how a zero is printed.
//
// FOUR RULES LIVE HERE, ONCE EACH.
//
//   THE HEADER IS ON EVERY REPORT. Spec 10, verbatim: nama BUMN, nama laporan,
//   periode, cabang, tanggal cetak, nama pencetak. Not on some of them. It
//   comes from the API's own `HeaderLaporan`, so the screen cannot invent a
//   branch name or a print date that the report body was not built with.
//
//   AND IT CARRIES TWO CLAIMS THE PAPER WOULD OTHERWISE LOSE. `sumberData`
//   says whether these figures were read from a closed period's FROZEN
//   balances or computed live from an open ledger, and `sumberTemplate` says
//   whether the layout came from the period's own stamped template or was
//   resolved by date. Those are different claims about the same page, an
//   auditor reading it two years later has no other way to tell, and a header
//   that shows only the period would let a live figure for an open month be
//   filed as if it were final.
//
//   ZERO RENDERS AS "0,00", NEVER BLANK, and a figure that cannot be read
//   renders as a visible marker and never as a number. Both come from
//   packages/ui's `formatMoney`; nothing in this folder formats money on its
//   own. See `Nilai`.
//
//   THE COMPARATIVE COLUMN IS NOT ONE KIND OF THING. A flow statement's
//   comparative is a SPAN (the same months a year earlier) and a position
//   statement's is a POINT (the preceding year end). They are deliberately
//   different and `Pembanding` prints which one is on screen rather than
//   letting the two look alike.
import { useMemo, useState, type ReactNode } from "react";
import {
  Button,
  ErrorState,
  Icon,
  Panel,
  Select,
  formatDate,
  formatMoney,
  UNPARSEABLE,
} from "@krakatausteel/ui";
import {
  cabangLaporan,
  periodeLaporan,
  type Angka,
  type FilterCabangLaporan,
  type HeaderLaporan,
  type KolomPembanding,
  type OpsiPeriode,
} from "../../api/laporan";
import { useApi, type HasilApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useRouter } from "../../router";
import { Muat, Penyaring, useLayarKecil } from "../shared/parts";

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

/** The API's `Uang`: a decimal, optionally signed, at most two places. */
const POLA_UANG = /^-?\d+(\.\d{1,2})?$/;

/**
 * One figure on a report.
 *
 * Zero prints "0,00", because the accounting team cross checks on the printed
 * zero and a blank cell is indistinguishable from a row that failed to
 * arrive. A value that is not a figure prints the marker `packages/ui` uses
 * everywhere else, carries what actually arrived in its tooltip, and is never
 * quietly rendered as a zero: on a page somebody signs, a silent Rp 0,00
 * standing in for a number that never came is the wrong answer with nothing
 * admitting it.
 *
 * Negatives print in accounting parentheses, which is the house style of every
 * statement in spec 10.3 and the grammar the API's own `tampil` field uses.
 */
export function Nilai({ angka }: { angka: Angka | null | undefined }) {
  const nilai = angka?.nilai;
  if (typeof nilai !== "string" || !POLA_UANG.test(nilai)) {
    return (
      <span className="cell-invalid" title={`Nilai tidak dapat dibaca: ${String(nilai)}`}>
        {UNPARSEABLE}
      </span>
    );
  }
  return <span className="angka">{formatMoney(nilai, { parenthesizeNegative: true })}</span>;
}

/** The same figure as plain text, for a table cell rendered through DataTable. */
export function teksNilai(angka: Angka | null | undefined): string {
  const nilai = angka?.nilai;
  if (typeof nilai !== "string" || !POLA_UANG.test(nilai)) return UNPARSEABLE;
  return formatMoney(nilai, { parenthesizeNegative: true });
}

/**
 * The same rules for a raw `Uang` string. Report 24 comes from the RKA module,
 * which returns bare NUMERIC(20,2) text rather than the laporan module's
 * `{ nilai, tampil }` pair, and it gets the same treatment: zero prints
 * "0,00", an unreadable value prints the marker, and nothing is ever silently
 * rendered as nothing.
 */
export function NilaiUang({ nilai }: { nilai: string | null | undefined }) {
  if (typeof nilai !== "string" || !POLA_UANG.test(nilai)) {
    return (
      <span className="cell-invalid" title={`Nilai tidak dapat dibaca: ${String(nilai)}`}>
        {UNPARSEABLE}
      </span>
    );
  }
  return <span className="angka">{formatMoney(nilai, { parenthesizeNegative: true })}</span>;
}

/**
 * A figure that is ALLOWED TO BE ABSENT, and prints why instead of a marker.
 *
 * `Nilai` treats a missing figure as unreadable and prints "tidak sah", which
 * is right for a statement line that must always have a number and wrong for a
 * column that legitimately has none: a sector with no budget line has NO
 * anggaran, and "tidak sah" on that row would send an operator hunting a data
 * fault that is not there. Once a reader sees that marker where it does not
 * belong they stop trusting it everywhere, so absence gets its own words.
 */
export function NilaiAtau({
  angka,
  kosong,
}: {
  angka: Angka | null | undefined;
  /** What an absent figure means here, e.g. "Tidak dianggarkan". */
  kosong: string;
}) {
  if (angka === null || angka === undefined) {
    return <span className="angka-kosong">{kosong}</span>;
  }
  return <Nilai angka={angka} />;
}

/**
 * A percentage of achievement.
 *
 * NULL IS NOT ZERO, and this is the one place on a variance report where the
 * difference matters most: a dimension with no budget at all has NO percentage
 * of achievement, and printing "0,00%" would report a target that was missed
 * where in fact no target was ever set.
 */
export function NilaiPersen({ nilai }: { nilai: string | null | undefined }) {
  if (nilai === null || nilai === undefined) {
    return <span className="angka-kosong">Tidak dapat dihitung</span>;
  }
  if (!/^-?\d+(\.\d{1,4})?$/.test(nilai)) {
    return (
      <span className="cell-invalid" title={`Nilai tidak dapat dibaca: ${String(nilai)}`}>
        {UNPARSEABLE}
      </span>
    );
  }
  return <span className="angka">{formatMoney(nilai, { decimals: 2 })}%</span>;
}

// ---------------------------------------------------------------------------
// The header spec 10 puts on every report
// ---------------------------------------------------------------------------

const LABEL_SUMBER_DATA: Record<string, string> = {
  SNAPSHOT_PERIODE: "Saldo beku periode tertutup",
  LEDGER_LIVE: "Dihitung langsung dari ledger",
};

const JELAS_SUMBER_DATA: Record<string, string> = {
  SNAPSHOT_PERIODE:
    "Periode ini sudah ditutup, jadi angka dibaca dari saldo yang dibekukan saat closing dan akan sama persis bila laporan dicetak ulang nanti.",
  LEDGER_LIVE:
    "Periode ini masih terbuka, jadi angka dihitung dari ledger saat ini dan bisa berubah selama masih ada jurnal yang masuk.",
};

const LABEL_SUMBER_TEMPLATE: Record<string, string> = {
  TEMPLATE_PERIODE: "Template yang dicap pada periode",
  TEMPLATE_BERLAKU: "Template berlaku menurut tanggal",
  TANPA_TEMPLATE: "Tanpa template laporan",
};

const JELAS_SUMBER_TEMPLATE: Record<string, string> = {
  TEMPLATE_PERIODE:
    "Susunan baris diambil dari template yang tercatat pada periode itu sendiri, jadi tata letaknya tidak berubah walaupun template dirapikan setelahnya.",
  TEMPLATE_BERLAKU:
    "Periode ini belum mencap template, jadi susunan baris diambil dari template yang berlaku menurut tanggal periode.",
  TANPA_TEMPLATE:
    "Tidak ada template laporan yang cocok, jadi baris disusun langsung dari bagan akun.",
};

export function Fakta({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="kop-fakta">
      <dt className="kop-label">{label}</dt>
      <dd className="kop-nilai">{value}</dd>
    </div>
  );
}

/**
 * The report header. Every field is the server's own: the screen never
 * composes a branch name, a period label or a print date, because the body
 * below it was built with those and a second opinion would print a page whose
 * heading and figures describe different things.
 */
export function KopLaporan({ header }: { header: HeaderLaporan }) {
  const sumber = LABEL_SUMBER_DATA[header.sumberData] ?? header.sumberData;
  const template = LABEL_SUMBER_TEMPLATE[header.sumberTemplate] ?? header.sumberTemplate;
  return (
    <Panel
      as="h2"
      title={header.namaLaporan}
      description={header.namaBumn}
      className="kop-laporan"
    >
      <dl className="kop-grid">
        <Fakta label="Periode" value={header.periodeLabel} />
        <Fakta label="Cabang" value={header.namaCabang} />
        <Fakta label="Tanggal cetak" value={formatDate(header.tanggalCetak)} />
        <Fakta label="Dicetak oleh" value={header.dicetakOleh} />
        <Fakta
          label="Sumber angka"
          value={
            <>
              <span className="kop-klaim">{sumber}</span>
              <span className="kop-jelas">{JELAS_SUMBER_DATA[header.sumberData] ?? ""}</span>
            </>
          }
        />
        <Fakta
          label="Sumber tata letak"
          value={
            <>
              <span className="kop-klaim">{template}</span>
              <span className="kop-jelas">
                {JELAS_SUMBER_TEMPLATE[header.sumberTemplate] ?? ""}
              </span>
            </>
          }
        />
      </dl>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// The comparative column, and what kind of comparative it is
// ---------------------------------------------------------------------------

export type JenisPembanding = "RENTANG" | "TITIK";

/**
 * States what the two figure columns mean.
 *
 * "RENTANG" is a flow statement: the comparative covers the same months one
 * year earlier, so both columns are periods. "TITIK" is a position statement:
 * the comparative is the balance at the preceding financial year end, so both
 * columns are dates. The two are not interchangeable and this line is the only
 * thing on the page that says which one is being read.
 */
export function Pembanding({
  kolom,
  jenis,
}: {
  kolom: KolomPembanding;
  jenis: JenisPembanding;
}) {
  return (
    <p className="page-note">
      <Icon name="info" size={16} />
      <span>
        {jenis === "RENTANG" ? (
          <>
            Kolom pembanding adalah rentang periode: {kolom.labelTahunIni} mencakup{" "}
            {formatDate(kolom.dariTahunIni)} sampai {formatDate(kolom.sampaiTahunIni)}, dan{" "}
            {kolom.labelTahunLalu} mencakup {formatDate(kolom.dariTahunLalu)} sampai{" "}
            {formatDate(kolom.sampaiTahunLalu)}.
          </>
        ) : (
          <>
            Kolom pembanding adalah posisi pada satu tanggal: {kolom.labelTahunIni} adalah saldo
            per {formatDate(kolom.sampaiTahunIni)}, dan {kolom.labelTahunLalu} adalah saldo per{" "}
            {formatDate(kolom.sampaiTahunLalu)}.
          </>
        )}
      </span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// The filter set spec 10 puts above every report
// ---------------------------------------------------------------------------

export const SEMUA_CABANG = "SEMUA";

const LABEL_STATUS_PERIODE: Record<string, string> = {
  OPEN: "Periode terbuka",
  CLOSING_IN_PROGRESS: "Periode sedang ditutup",
  CLOSED: "Periode tertutup",
};

export interface FilterLaporanState {
  periodeId: string | null;
  cabangId: string | null;
  periode: OpsiPeriode | null;
  daftarPeriode: readonly OpsiPeriode[];
  cabang: FilterCabangLaporan | null;
  kontrol: ReactNode;
  /** True when both reference reads answered and a report may be requested. */
  siap: boolean;
  gagal: ReactNode | null;
}

/**
 * Period and branch, kept in the query string so a report a colleague is asked
 * to check opens on the same figures when the link is pasted.
 *
 * `perluPeriode` is false for report 16 alone: a chart of accounts is a
 * structure, not a balance, so offering it a period would invite a reader to
 * believe the tree changed with the month.
 */
export function useFilterLaporan(
  options: {
    perluPeriode?: boolean;
    /** Controls only one report needs, e.g. report 22's account picker. They
     *  sit in the SAME filter block, so on a phone they end up behind the same
     *  one sheet instead of stranded above it. */
    tambahan?: ReactNode;
    /** One phrase naming what `tambahan` currently selects, for the phone
     *  trigger line. */
    ringkasTambahan?: string;
  } = {},
): FilterLaporanState {
  const perluPeriode = options.perluPeriode ?? true;
  const { query, setQuery } = useRouter();
  const kecil = useLayarKecil();

  const periode = useApi(() => periodeLaporan(), [], { enabled: perluPeriode });
  const cabang = useApi(() => cabangLaporan(), []);

  const daftarPeriode = periode.data?.data ?? [];
  const pilihanPeriodeUrl = query.get("periode");
  const periodeId = useMemo(() => {
    if (!perluPeriode) return null;
    if (pilihanPeriodeUrl && daftarPeriode.some((p) => p.id === pilihanPeriodeUrl)) {
      return pilihanPeriodeUrl;
    }
    return daftarPeriode[0]?.id ?? null;
  }, [perluPeriode, pilihanPeriodeUrl, daftarPeriode]);

  const cabangUrl = query.get("cabang");
  const opsiCabang = cabang.data?.cabang ?? [];
  const bolehSemua = cabang.data?.bolehSemuaCabang ?? false;
  const cabangPilihan = useMemo(() => {
    if (cabangUrl === SEMUA_CABANG) return bolehSemua ? SEMUA_CABANG : null;
    if (cabangUrl && opsiCabang.some((c) => c.id === cabangUrl)) return cabangUrl;
    if (bolehSemua) return SEMUA_CABANG;
    return cabang.data?.cabangSendiriId ?? null;
  }, [cabangUrl, opsiCabang, bolehSemua, cabang.data]);

  const periodeTerpilih = daftarPeriode.find((p) => p.id === periodeId) ?? null;

  const gagalPeriode = perluPeriode && periode.status === "gagal";
  const gagalCabang = cabang.status === "gagal";
  const gagal =
    gagalPeriode || gagalCabang ? (
      <ErrorState
        title="Gagal memuat filter laporan"
        detail={periode.error ?? cabang.error}
        sumber={gagalPeriode ? "GET /api/laporan/periode" : "GET /api/laporan/cabang"}
        onRetry={() => {
          if (gagalPeriode) periode.reload();
          if (gagalCabang) cabang.reload();
        }}
      />
    ) : null;

  const memuat =
    (perluPeriode && periode.status === "memuat") || cabang.status === "memuat";

  const cabangOptions = [
    ...(bolehSemua ? [{ value: SEMUA_CABANG, label: "Semua Cabang" }] : []),
    ...opsiCabang.map((c) => ({ value: c.id, label: `${c.kode} ${c.nama}` })),
  ];

  const namaCabangTerpilih =
    cabangPilihan === SEMUA_CABANG
      ? "Semua Cabang"
      : (opsiCabang.find((c) => c.id === cabangPilihan)?.nama ?? "Cabang belum dipilih");

  const isi = (
    <div className="filter-laporan">
      {perluPeriode ? (
        <label className="filter-laporan-group">
          <span className="filter-laporan-label">Periode</span>
          <Select
            aria-label="Periode laporan"
            value={periodeId ?? ""}
            disabled={daftarPeriode.length === 0}
            onChange={(event) => setQuery("periode", event.currentTarget.value)}
            options={
              daftarPeriode.length === 0
                ? [{ value: "", label: memuat ? "Memuat periode" : "Tidak ada periode" }]
                : daftarPeriode.map((p) => ({ value: p.id, label: labelPeriode(p) }))
            }
          />
        </label>
      ) : null}
      <label className="filter-laporan-group">
        <span className="filter-laporan-label">Cabang</span>
        <Select
          aria-label="Cabang laporan"
          value={cabangPilihan ?? ""}
          disabled={cabangOptions.length === 0}
          onChange={(event) => setQuery("cabang", event.currentTarget.value)}
          options={
            cabangOptions.length === 0
              ? [{ value: "", label: memuat ? "Memuat cabang" : "Tidak ada cabang" }]
              : cabangOptions
          }
        />
      </label>
      {options.tambahan}
      <div className="filter-laporan-aksi">
        <Button
          variant="secondary"
          onClick={() => {
            setQuery("periode", null);
            setQuery("cabang", null);
          }}
        >
          Atur ulang
        </Button>
      </div>
      {/* The period's status, on its own full width line UNDER the controls
          rather than as a suffix inside the option text or a hint inside one
          group. A native select truncates, so "Agustus 2026 (OPE" is a worse
          answer than no answer, and a hint inside one group pushes that group
          taller and knocks the row out of alignment. It is worth saying before
          the report is asked for at all, because it decides whether the
          figures about to appear are frozen or still moving. */}
      {perluPeriode && periodeTerpilih ? (
        <p className="filter-laporan-catatan">
          {LABEL_STATUS_PERIODE[periodeTerpilih.status] ?? periodeTerpilih.status}.{" "}
          {periodeTerpilih.status === "CLOSED"
            ? "Angka dibaca dari saldo yang dibekukan saat closing, jadi laporan ini akan sama persis bila dicetak ulang nanti."
            : "Angka dihitung langsung dari ledger dan masih bisa berubah selama masih ada jurnal yang masuk."}
        </p>
      ) : null}
    </div>
  );

  const ringkas = [
    perluPeriode
      ? periodeTerpilih
        ? labelPeriode(periodeTerpilih)
        : "Periode belum dipilih"
      : null,
    namaCabangTerpilih,
    options.ringkasTambahan ?? null,
  ]
    .filter((bagian): bagian is string => bagian !== null && bagian !== "")
    .join(", ");

  const kontrol = kecil ? <Penyaring ringkas={ringkas}>{isi}</Penyaring> : isi;

  return {
    periodeId,
    cabangId: cabangPilihan === SEMUA_CABANG ? null : cabangPilihan,
    periode: periodeTerpilih,
    daftarPeriode,
    cabang: cabang.data,
    kontrol,
    siap: gagal === null && !memuat && (!perluPeriode || periodeId !== null),
    gagal,
  };
}

const NAMA_BULAN_PENDEK = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
] as const;

export function labelPeriode(periode: OpsiPeriode): string {
  return `${NAMA_BULAN_PENDEK[periode.bulan - 1] ?? periode.bulan} ${periode.tahun}`;
}

// ---------------------------------------------------------------------------
// The page frame
// ---------------------------------------------------------------------------

/**
 * One report page: the title, the filter set, then the report or the honest
 * reason there is none. `Muat` is what makes the last part true: a read that
 * failed renders a panel naming the endpoint, never an empty statement that
 * reads as "this entity has no assets".
 */
export function HalamanLaporan<T>({
  route,
  filter,
  hasil,
  judul,
  sumber,
  crumb = "Laporan Akuntansi",
  diamLabel,
  aksi,
  sebelum,
  children,
}: {
  route: PageRoute;
  filter: FilterLaporanState;
  hasil: HasilApi<T>;
  judul: string;
  sumber: string;
  /** Which of spec 10's four groupings this report belongs to. */
  crumb?: string;
  /** What to say when the report has deliberately not been asked for yet. */
  diamLabel?: string;
  aksi?: ReactNode;
  /** A panel that has to be seen whether or not the report itself loaded, e.g.
   *  the failure of a reference read the report cannot be asked for without. */
  sebelum?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  return (
    <div className="page laporan-page">
      <header className="page-head">
        <p className="page-crumb">{crumb}</p>
        <div className="page-head-row">
          <div className="page-head-text">
            <h1 className="page-title">{route.title}</h1>
            <p className="page-sub">{route.summary}</p>
          </div>
          {aksi ? <div className="page-actions">{aksi}</div> : null}
        </div>
      </header>

      {filter.kontrol}
      {filter.gagal}
      {sebelum}

      {filter.gagal === null ? (
        <Muat
          hasil={hasil}
          judul={judul}
          sumber={sumber}
          diamLabel={diamLabel ?? "Pilih periode terlebih dahulu untuk membuka laporan ini."}
        >
          {children}
        </Muat>
      ) : null}

      <p className="page-note">
        <Icon name="info" size={16} />
        <span>
          Laporan ini hanya membaca. Export Excel dan export PDF belum tersedia dan belum punya
          kewenangan sendiri, jadi tidak ada tombolnya di halaman ini.
        </span>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A statement body: label column plus two figure columns
// ---------------------------------------------------------------------------

export interface BarisStatementTampil {
  key: string;
  label: string;
  level: number;
  tebal?: boolean;
  /** A subtotal or total rule above the row. */
  garisAtas?: boolean;
  tahunIni: Angka;
  tahunLalu: Angka;
  /** The accounts folded into this line, shown on demand. */
  akunKode?: readonly string[];
}

/**
 * The shape every statement in spec 10.3 shares: an indented label and two
 * figures. It is a real table on a desk and the same rows as stacked pairs on
 * a phone, driven by ONE array so the two can never disagree.
 */
export function TabelStatement({
  baris,
  labelTahunIni,
  labelTahunLalu,
  labelKolom = "Uraian",
  kosongJudul,
  kosongPesan,
}: {
  baris: readonly BarisStatementTampil[];
  labelTahunIni: string;
  labelTahunLalu: string;
  labelKolom?: string;
  kosongJudul: string;
  kosongPesan: string;
}) {
  if (baris.length === 0) {
    return (
      <div className="antrean-kosong">
        <span className="antrean-kosong-icon" aria-hidden="true">
          <Icon name="list" size={20} />
        </span>
        <p className="antrean-kosong-title">{kosongJudul}</p>
        <p className="antrean-kosong-desc">{kosongPesan}</p>
      </div>
    );
  }
  return (
    <div className="statement">
      <div className="statement-head" role="presentation">
        <span className="statement-uraian">{labelKolom}</span>
        <span className="statement-angka">{labelTahunIni}</span>
        <span className="statement-angka">{labelTahunLalu}</span>
      </div>
      <ul className="statement-list">
        {baris.map((row) => (
          <li
            key={row.key}
            className={[
              "statement-row",
              `is-level-${Math.min(row.level, 3)}`,
              row.tebal ? "is-tebal" : "",
              row.garisAtas ? "is-garis" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <span className="statement-uraian">
              <span className="statement-nama">{row.label}</span>
              {row.akunKode && row.akunKode.length > 0 ? (
                <span className="statement-akun">Akun: {row.akunKode.join(", ")}</span>
              ) : null}
            </span>
            <span className="statement-angka">
              <span className="statement-angka-label">{labelTahunIni}</span>
              <Nilai angka={row.tahunIni} />
            </span>
            <span className="statement-angka">
              <span className="statement-angka-label">{labelTahunLalu}</span>
              <Nilai angka={row.tahunLalu} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A row of headline figures under a statement, at one rhythm across every
 * report. Values arrive already rendered through `Nilai`.
 */
export function RingkasAngka({
  items,
}: {
  items: readonly { label: string; tahunIni: Angka; tahunLalu: Angka }[];
}) {
  return (
    <ul className="ringkas-angka">
      {items.map((item) => (
        <li className="ringkas-angka-item" key={item.label}>
          <span className="ringkas-angka-label">{item.label}</span>
          <span className="ringkas-angka-baris">
            <span className="ringkas-angka-key">Tahun ini</span>
            <Nilai angka={item.tahunIni} />
          </span>
          <span className="ringkas-angka-baris">
            <span className="ringkas-angka-key">Tahun lalu</span>
            <Nilai angka={item.tahunLalu} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A disclosure that shows a long note without pushing the report down. */
export function Catatan({ judul, children }: { judul: string; children: ReactNode }) {
  const [buka, setBuka] = useState(false);
  return (
    <div className="catatan">
      <button
        type="button"
        className="catatan-btn"
        aria-expanded={buka}
        onClick={() => setBuka((nilai) => !nilai)}
      >
        <Icon name={buka ? "chevronDown" : "chevronRight"} size={16} />
        <span>{judul}</span>
      </button>
      {buka ? <div className="catatan-isi">{children}</div> : null}
    </div>
  );
}
