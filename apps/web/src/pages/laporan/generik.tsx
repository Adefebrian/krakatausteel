// THE SHAPE THE OPERATIONAL REPORTS SHARE, BUILT ONCE.
//
// Spec 10 asks for thirty one reports. Twenty three of them are answered by
// modules/laporan's operational engine, and eighteen of those twenty three are
// literally the same page: a set of parameters at the top, one table with a
// footing row, and a set of totals under it. Writing eighteen screens for one
// page would have produced eighteen slightly different filter rows, eighteen
// opinions about where the totals go and eighteen empty states, and the reader
// would have to relearn the page on every menu item.
//
// So a report DECLARES itself here and the frame is shared:
//
//   `DeklarasiLaporan` says which endpoint answers it, which parameters it
//   takes, what its columns are, what its phone card says, and what its totals
//   are. Everything else -- the header spec 10 puts on every report, the
//   period and branch filters, the four load states, the failure panel that
//   names the endpoint, the table-on-a-desk and cards-on-a-phone pair -- comes
//   from here and cannot differ between two reports.
//
// AND WHERE A REPORT GENUINELY IS NOT THIS SHAPE IT DOES NOT COME THROUGH
// HERE. The two matrices (reports 3 and 11), the ageing grid (8), the
// receivable card (9) and the demographic distributions (27) have their own
// screens, because bending a table driver until it could also draw a matrix
// would have produced a driver that served neither well. Five bespoke screens
// and one shared frame is the honest split, not a failure of the frame.
//
// THREE RULES THIS FILE KEEPS, and each of them is a mistake already made once
// in this product:
//
//   AN ABSENT FIGURE IS NOT AN UNREADABLE ONE. A nullable column renders
//   through `NilaiAtau` with the words for its own absence, never through
//   `Nilai`, which would print the "tidak sah" marker on a row that is
//   perfectly fine and teach the reader to ignore the marker everywhere else.
//
//   A CARD IS A FIXED SHAPE. `KartuBaris` is title, one sub line, one meta, one
//   figure and one status, so no row's content can make one card taller than
//   its neighbour and a phone list keeps reading as one system.
//
//   THE TOTALS ARE ALWAYS VISIBLE, on the desk as the table's own footing row
//   and on a phone as the totals panel, because the footing row of a table
//   that has become a stack of cards is otherwise simply lost.
import { useMemo, type ReactNode } from "react";
import {
  DataTable,
  Icon,
  Panel,
  Select,
  type Column,
} from "@krakatausteel/ui";
import type { ModeLaporan } from "../../api/laporan-operasional";
import { useApi, type HasilApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useRouter } from "../../router";
import { AntreanKosong, hariIni, type KartuBaris } from "../shared/parts";
import {
  HalamanLaporan,
  KopLaporan,
  useFilterLaporan,
  type FilterLaporanState,
} from "./parts";

// ---------------------------------------------------------------------------
// The window: BULANAN or KUMULATIF_YTD
// ---------------------------------------------------------------------------

export const MODE_BULANAN: ModeLaporan = "BULANAN";
export const MODE_YTD: ModeLaporan = "KUMULATIF_YTD";

const LABEL_MODE: Record<ModeLaporan, string> = {
  BULANAN: "Bulan berjalan saja",
  KUMULATIF_YTD: "Kumulatif sejak awal tahun buku",
};

export interface KontrolMode {
  mode: ModeLaporan;
  kontrol: ReactNode;
  ringkas: string;
}

/**
 * The one parameter that changes what a figure MEANS rather than which rows
 * are in it.
 *
 * It is a real control and never a silent default, because a monthly figure
 * and a year to date figure look identical on paper: the same column header,
 * the same currency, the same footing. The only thing that says which one is
 * on screen is this control and the sentence under it, so both are always
 * present on a report that has the parameter at all.
 */
export function useModeLaporan(): KontrolMode {
  const { query, setQuery } = useRouter();
  const dariUrl = query.get("mode");
  const mode: ModeLaporan = dariUrl === "KUMULATIF_YTD" ? "KUMULATIF_YTD" : "BULANAN";
  const kontrol = (
    <label className="filter-laporan-group">
      <span className="filter-laporan-label">Jendela angka</span>
      <Select
        aria-label="Jendela angka laporan"
        value={mode}
        onChange={(event) => setQuery("mode", event.currentTarget.value)}
        options={[
          { value: "BULANAN", label: LABEL_MODE.BULANAN },
          { value: "KUMULATIF_YTD", label: LABEL_MODE.KUMULATIF_YTD },
        ]}
      />
    </label>
  );
  return { mode, kontrol, ringkas: LABEL_MODE[mode] };
}

// ---------------------------------------------------------------------------
// A window that is a date range rather than a period
// ---------------------------------------------------------------------------

export interface RentangTanggal {
  dariTanggal: string;
  sampaiTanggal: string;
}

/** Today plus `hari` days, as the YYYY-MM-DD every API date uses. */
export function tanggalPlus(hari: number): string {
  const dasar = new Date(`${hariIni()}T00:00:00Z`);
  dasar.setUTCDate(dasar.getUTCDate() + hari);
  return dasar.toISOString().slice(0, 10);
}

export interface KontrolRentang {
  rentang: RentangTanggal;
  kontrol: ReactNode;
  ringkas: string;
  /** False when the range is back to front, which the engine also refuses. */
  sah: boolean;
}

/**
 * The two dates reports 5 and 31 take instead of a period.
 *
 * A range whose end precedes its start is refused HERE as well as by the
 * engine, and the report is simply not asked for. The engine's refusal is the
 * guarantee; this one exists so the reader is told which control is wrong
 * rather than reading a server error about a window they cannot see.
 */
export function useRentangTanggal(
  bawaan: RentangTanggal,
  label: { dari: string; sampai: string },
): KontrolRentang {
  const { query, setQuery } = useRouter();
  const dariTanggal = query.get("dari") ?? bawaan.dariTanggal;
  const sampaiTanggal = query.get("sampai") ?? bawaan.sampaiTanggal;
  const sah = dariTanggal !== "" && sampaiTanggal !== "" && dariTanggal <= sampaiTanggal;

  const kontrol = (
    <>
      <label className="filter-laporan-group">
        <span className="filter-laporan-label">{label.dari}</span>
        <input
          type="date"
          className="control"
          aria-label={label.dari}
          value={dariTanggal}
          onChange={(event) => setQuery("dari", event.currentTarget.value)}
        />
      </label>
      <label className="filter-laporan-group">
        <span className="filter-laporan-label">{label.sampai}</span>
        <input
          type="date"
          className="control"
          aria-label={label.sampai}
          value={sampaiTanggal}
          onChange={(event) => setQuery("sampai", event.currentTarget.value)}
        />
      </label>
      {sah ? null : (
        <p className="filter-laporan-catatan" role="alert">
          Tanggal akhir tidak boleh lebih awal daripada tanggal mulai, jadi laporan belum
          diminta ke server.
        </p>
      )}
    </>
  );

  return {
    rentang: { dariTanggal, sampaiTanggal },
    kontrol,
    ringkas: `${dariTanggal} sampai ${sampaiTanggal}`,
    sah,
  };
}

// ---------------------------------------------------------------------------
// The totals under every report
// ---------------------------------------------------------------------------

export interface TotalItem {
  label: string;
  /** Already rendered, through `Nilai`, `NilaiAtau`, `NilaiPersen` or text. */
  nilai: ReactNode;
  /** What the figure is, e.g. "Nilai" or "Jumlah". */
  kunci?: string;
  /** A second figure on the same tile, e.g. the comparison it is read with. */
  kedua?: { kunci: string; nilai: ReactNode };
}

/**
 * The footing of a report, in the SAME shape the seven accounting statements
 * already use for theirs, so a reader moving between an operational report and
 * a statement finds the totals in the same place, at the same rhythm, spelled
 * the same way.
 */
export function TotalLaporan({
  items,
  judul = "Total laporan",
  deskripsi,
}: {
  items: readonly TotalItem[];
  judul?: string;
  deskripsi?: string;
}) {
  if (items.length === 0) return null;
  return (
    <Panel as="h2" title={judul} description={deskripsi}>
      <ul className="ringkas-angka">
        {items.map((item) => (
          <li className="ringkas-angka-item" key={item.label}>
            <span className="ringkas-angka-label">{item.label}</span>
            <span className="ringkas-angka-baris">
              <span className="ringkas-angka-key">{item.kunci ?? "Nilai"}</span>
              {item.nilai}
            </span>
            {item.kedua ? (
              <span className="ringkas-angka-baris">
                <span className="ringkas-angka-key">{item.kedua.kunci}</span>
                {item.kedua.nilai}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// One list, two shapes, one source of rows
// ---------------------------------------------------------------------------

/**
 * A dense sortable table with a real footing row at a desk, and the same rows
 * as fixed shape cards on a phone. Both are driven by ONE array, so they
 * cannot disagree about what is in the report.
 *
 * The footing lives in the COLUMNS (`Column.footer`), which is what makes it a
 * real `tfoot` rather than a last row that sorts away with the data.
 */
export function TabelLaporan<Row>({
  columns,
  rows,
  rowKey,
  kartu,
  kosongJudul,
  kosongPesan,
  caption,
}: {
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  kartu: (row: Row) => KartuBaris;
  kosongJudul: string;
  kosongPesan: string;
  caption?: string;
}) {
  return (
    <>
      <div className="daftar-tabel">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={rowKey}
          caption={caption}
          emptyTitle={kosongJudul}
          emptyDescription={kosongPesan}
        />
      </div>
      <div className="daftar-kartu">
        {rows.length === 0 ? (
          <AntreanKosong title={kosongJudul} description={kosongPesan} />
        ) : (
          <ul className="kartu-list">
            {rows.map((row) => {
              const isi = kartu(row);
              return (
                <li className="kartu-item" key={rowKey(row)}>
                  {/* A read only report row is not a destination, so it is a
                      plain card and not a disabled button: Chrome greys a
                      disabled button's whole subtree, which once turned an
                      entire perfectly good list into disabled ink. */}
                  <div className="kartu-btn is-statis">
                    <span className="kartu-head">
                      <span className="kartu-judul">{isi.judul}</span>
                      {isi.status}
                    </span>
                    <span className="kartu-sub">{isi.sub}</span>
                    <span className="kartu-foot">
                      <span className="kartu-meta">{isi.meta ?? ""}</span>
                      {isi.nilai === undefined ? null : (
                        <span className="kartu-nilai">
                          <span className="kartu-nilai-label">{isi.nilaiLabel ?? "Nilai"}</span>
                          <span className="kartu-nilai-val">{isi.nilai}</span>
                        </span>
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// The declaration
// ---------------------------------------------------------------------------

export interface ParamLaporan {
  periodeId: string;
  cabangId: string | null;
  mode: ModeLaporan;
}

/**
 * How a report RENDERS. Deliberately separate from how it is FETCHED: the two
 * reports whose window is a date range (5 and 31) supply their own parameters
 * and their own read, and they must not have to carry a fetch function they
 * never call. A stub that throws would be a landmine waiting for the day
 * somebody wired the generic screen to one of them.
 */
export interface BadanDeklarasi<T, Row> {
  /** Which of spec 10's four groupings this report is filed under. */
  kelompok: string;
  /** What the page says it is loading, in the failure panel. */
  judul: string;
  /** The endpoint, so a failure can be chased without a console. */
  sumber: string;
  /** False for a report with no period at all. */
  perluPeriode?: boolean;
  /** True for a report that takes BULANAN or KUMULATIF_YTD. */
  pakaiMode?: boolean;
  baris: (data: T) => readonly Row[];
  rowKey: (row: Row) => string;
  kolom: (data: T) => readonly Column<Row>[];
  kartu: (row: Row) => KartuBaris;
  tabel: { judul: string; deskripsi?: (data: T) => string };
  kosong: { judul: string; pesan: string };
  total: (data: T) => readonly TotalItem[];
  totalJudul?: string;
  totalDeskripsi?: string;
  /** Extra panels a report carries beside its main table, e.g. a per status
   *  breakdown. They render UNDER the totals, in the same Panel chrome. */
  bagian?: (data: T) => ReactNode;
  /** One sentence the report cannot be read correctly without. */
  catatan?: (data: T) => ReactNode;
}

/** A report the generic screen can also FETCH: period, branch and window. */
export interface DeklarasiLaporan<T, Row> extends BadanDeklarasi<T, Row> {
  ambil: (param: ParamLaporan) => Promise<T>;
}

/**
 * One operational report page.
 *
 * `route` supplies the title and the summary, so the page heading and the
 * navigation entry cannot disagree, and the declaration supplies everything
 * that is specific to this report and nothing that is not.
 */
export function LaporanTabel<T, Row>({
  route,
  deklarasi,
}: {
  route: PageRoute;
  deklarasi: DeklarasiLaporan<T, Row>;
}) {
  const mode = useModeLaporan();
  const perluPeriode = deklarasi.perluPeriode ?? true;
  const filter = useFilterLaporan({
    perluPeriode,
    ...(deklarasi.pakaiMode ? { tambahan: mode.kontrol, ringkasTambahan: mode.ringkas } : {}),
  });

  const periodeId = filter.periodeId ?? "";
  const cabangId = filter.cabangId;
  const modeTerpakai = deklarasi.pakaiMode ? mode.mode : MODE_BULANAN;

  const hasil = useApi(
    () => deklarasi.ambil({ periodeId, cabangId, mode: modeTerpakai }),
    [periodeId, cabangId, modeTerpakai],
    { enabled: filter.siap && (!perluPeriode || periodeId !== "") },
  );

  return (
    <IsiLaporan route={route} crumb={deklarasi.kelompok} filter={filter} hasil={hasil} deklarasi={deklarasi} />
  );
}

/**
 * The body every operational report renders, shared by the generic screen above
 * and by the four bespoke ones that supply their own parameters.
 */
export function IsiLaporan<T, Row>({
  route,
  crumb,
  filter,
  hasil,
  deklarasi,
  diamLabel,
}: {
  route: PageRoute;
  crumb: string;
  filter: FilterLaporanState;
  hasil: HasilApi<T>;
  deklarasi: BadanDeklarasi<T, Row>;
  diamLabel?: string;
}) {
  return (
    <HalamanLaporan
      route={route}
      filter={filter}
      hasil={hasil}
      judul={deklarasi.judul}
      sumber={deklarasi.sumber}
      crumb={crumb}
      {...(diamLabel ? { diamLabel } : {})}
    >
      {(data: T) => <BadanLaporan data={data} deklarasi={deklarasi} />}
    </HalamanLaporan>
  );
}

function BadanLaporan<T, Row>({
  data,
  deklarasi,
}: {
  data: T;
  deklarasi: BadanDeklarasi<T, Row>;
}) {
  const rows = useMemo(() => deklarasi.baris(data), [data, deklarasi]);
  const kolom = useMemo(() => deklarasi.kolom(data), [data, deklarasi]);
  const total = useMemo(() => deklarasi.total(data), [data, deklarasi]);
  const header = (data as { header?: unknown }).header;
  const catatan = deklarasi.catatan?.(data);

  return (
    <>
      {header ? <KopLaporan header={header as never} /> : null}

      <Panel
        as="h2"
        title={deklarasi.tabel.judul}
        description={deklarasi.tabel.deskripsi?.(data) ?? `${rows.length} baris.`}
      >
        <TabelLaporan
          columns={kolom}
          rows={rows}
          rowKey={deklarasi.rowKey}
          kartu={deklarasi.kartu}
          kosongJudul={deklarasi.kosong.judul}
          kosongPesan={deklarasi.kosong.pesan}
        />
      </Panel>

      <TotalLaporan
        items={total}
        judul={deklarasi.totalJudul ?? "Total laporan"}
        {...(deklarasi.totalDeskripsi ? { deskripsi: deklarasi.totalDeskripsi } : {})}
      />

      {deklarasi.bagian?.(data)}

      {catatan ? (
        <p className="page-note">
          <Icon name="info" size={16} />
          <span>{catatan}</span>
        </p>
      ) : null}
    </>
  );
}
