// Pieces shared by every Pendanaan UMK screen, so seventeen pages cannot
// drift into seventeen slightly different headers, loading states and failure
// panels.
//
// The one that matters is `Muat`. Every read on every PUMK page goes through
// it, which is why a screen in this module cannot accidentally render an empty
// table when the request actually failed: there are four states, they are
// exhaustive, and the failure state is a panel that names the endpoint.
import { useEffect, useState, type ReactNode } from "react";
import {
  Button,
  DataTable,
  ErrorState,
  Icon,
  Modal,
  Panel,
  StatusBadge,
  type Column,
  type IconName,
} from "@krakatausteel/ui";
import type { HasilApi } from "../../api/useApi";
import { groupOfPath, type PageRoute } from "../../nav";
import { Link, useRouter } from "../../router";

/** A DataTable column, re-exported so a page imports one module for a list. */
export type ColumnSpec<Row> = Column<Row>;

/** The page frame: crumb, title, one paragraph, and an optional action row. */
export function PumkPage({
  route,
  title,
  sub,
  actions,
  back,
  children,
}: {
  route?: PageRoute;
  title?: string;
  sub?: string;
  actions?: ReactNode;
  /** A link back to the list this page was opened from. */
  back?: { to: string; label: string };
  children: ReactNode;
}) {
  const group = route ? groupOfPath(route.path) : undefined;
  return (
    <div className="page pumk-page">
      <header className="page-head">
        {back ? (
          <Link className="page-back" to={back.to}>
            <Icon name="arrowLeft" size={16} />
            <span>{back.label}</span>
          </Link>
        ) : group ? (
          <p className="page-crumb">{group.label}</p>
        ) : null}
        <div className="page-head-row">
          <div className="page-head-text">
            <h1 className="page-title">{title ?? route?.title ?? ""}</h1>
            <p className="page-sub">{sub ?? route?.summary ?? ""}</p>
          </div>
          {actions ? <div className="page-actions">{actions}</div> : null}
        </div>
      </header>
      {children}
    </div>
  );
}

/**
 * Renders one read. Four states, no fifth, and the failure state is never a
 * quietly empty body: it says what failed, shows the server's own sentence and
 * names the endpoint, so "the API is not built yet" and "the database is down"
 * look the same to the reader, which is the truth of both.
 */
export function Muat<T>({
  hasil,
  judul,
  sumber,
  diamLabel = "Pilih dokumen terlebih dahulu.",
  children,
}: {
  hasil: HasilApi<T>;
  /** What the page was trying to load, e.g. "daftar proposal". */
  judul: string;
  /** The endpoint, so the failure can be chased without a console. */
  sumber: string;
  diamLabel?: string;
  children: (data: T) => ReactNode;
}) {
  if (hasil.status === "diam") {
    return <p className="muat-diam">{diamLabel}</p>;
  }
  if (hasil.status === "memuat") {
    return (
      <p className="muat-memuat" role="status">
        Memuat {judul}.
      </p>
    );
  }
  if (hasil.status === "gagal" || hasil.data === null) {
    return (
      <ErrorState
        title={`Gagal memuat ${judul}`}
        detail={hasil.error}
        sumber={sumber}
        onRetry={hasil.reload}
      />
    );
  }
  return <>{children(hasil.data)}</>;
}

/** The note every PUMK page carries: the UI is not the control. */
export function CatatanOtorisasi({ tambahan }: { tambahan?: string }) {
  return (
    <p className="page-note">
      <Icon name="info" size={16} />
      <span>
        Hak akses halaman ini divalidasi ulang di server, dan setiap penolakan tercatat pada audit
        log. {tambahan}
      </span>
    </p>
  );
}

/** The note every page that writes a journal carries. Spec section 1. */
export function CatatanPencatatan() {
  return (
    <p className="page-note">
      <Icon name="info" size={16} />
      <span>
        Aplikasi ini mencatat peristiwa yang sudah terjadi di luar sistem. Menyimpan data di
        halaman ini membentuk jurnal, bukan memindahkan dana.
      </span>
    </p>
  );
}

/** A small labelled row of chips at the top of a detail page. */
export function RingkasDokumen({
  items,
}: {
  items: readonly { label: string; value: ReactNode }[];
}) {
  return (
    <div className="ringkas">
      {items.map((item) => (
        <span className="ringkas-item" key={item.label}>
          <span className="ringkas-key">{item.label}</span>
          <span className="ringkas-val">{item.value}</span>
        </span>
      ))}
    </div>
  );
}

/** Kolektibilitas, always spelled out next to its colour (spec 5.1). */
export function Kolektibilitas({ kelas }: { kelas: string | null }) {
  if (!kelas) return <span className="kol-kosong">Belum dinilai</span>;
  return <StatusBadge status={kelas} />;
}

/** The empty body of a queue that legitimately has nothing in it. */
export function AntreanKosong({
  icon = "list",
  title,
  description,
}: {
  icon?: IconName;
  title: string;
  description: string;
}) {
  return (
    <div className="antrean-kosong">
      <span className="antrean-kosong-icon" aria-hidden="true">
        <Icon name={icon} size={20} />
      </span>
      <p className="antrean-kosong-title">{title}</p>
      <p className="antrean-kosong-desc">{description}</p>
    </div>
  );
}

/** A form's submit row, identical on every form in the module. */
export function BarisAksi({
  primary,
  secondary,
  error,
}: {
  primary: ReactNode;
  secondary?: ReactNode;
  error?: string | null;
}) {
  return (
    <div className="form-actions">
      {error ? (
        <p className="form-error" role="alert">
          <Icon name="alert" size={16} />
          <span>{error}</span>
        </p>
      ) : null}
      <div className="form-actions-row">
        {secondary}
        {primary}
      </div>
    </div>
  );
}

/**
 * A two panel form layout: the fields on the left, a live summary on the
 * right. Both columns are one card each, so the page reads as one system
 * rather than as a stack of boxes of different shapes.
 */
export function FormLayout({
  form,
  aside,
}: {
  form: ReactNode;
  aside?: ReactNode;
}) {
  return <div className={aside ? "form-layout has-aside" : "form-layout"}>{form}{aside}</div>;
}

/** A panel whose body is a grid of fields at one rhythm. */
export function FieldGrid({ children, columns = 2 }: { children: ReactNode; columns?: 1 | 2 }) {
  return <div className={`field-grid field-grid-${columns}`}>{children}</div>;
}

/** Today, as the `YYYY-MM-DD` every date input and every API date uses. */
export function hariIni(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A drill down link rendered as a button-sized target inside a table row. */
export function TautanDokumen({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link className="tautan-dokumen" to={to}>
      {children}
    </Link>
  );
}

/** The "back to the queue" control shared by every document form. */
export function KembaliKeAntrean({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick} leading={<Icon name="arrowLeft" size={16} />}>
      Kembali ke antrean
    </Button>
  );
}

/**
 * The selected document id, kept in the query string so a queue item survives
 * a refresh and can be pasted to a colleague.
 */
export function usePilihan(key: string): [string | null, (value: string | null) => void] {
  const { query, setQuery } = useRouter();
  return [query.get(key), (value: string | null) => setQuery(key, value)];
}

/** A panel used as a plain section on a form page. */
export function Bagian({
  title,
  description,
  aside,
  children,
  footer,
}: {
  title: string;
  description?: string;
  aside?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Panel as="h2" title={title} description={description} aside={aside} footer={footer}>
      {children}
    </Panel>
  );
}

/**
 * One list, two shapes, one source of rows.
 *
 * A dense sortable table is right at a desk and wrong on a phone, where an
 * accounting table becomes a sideways scroll nobody reads. So every list in
 * this module declares its columns once and its phone card once, and the CSS
 * shows exactly one of them. Both are driven by the same `rows`, so they can
 * never disagree about what is in the list.
 *
 * The card is a FIXED shape: title, one meta line, one figure, one status.
 * Nothing in a row can make one card taller than its neighbour, which is what
 * keeps the phone list reading as one system.
 */
export interface KartuBaris {
  judul: string;
  sub: string;
  /** Already formatted through formatMoney. */
  nilai?: string;
  nilaiLabel?: string;
  status?: ReactNode;
  meta?: string;
}

export function DaftarDokumen<Row>({
  columns,
  rows,
  rowKey,
  kartu,
  onPilih,
  emptyTitle,
  emptyDescription,
  caption,
}: {
  columns: readonly ColumnSpec<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  kartu: (row: Row) => KartuBaris;
  onPilih?: (row: Row) => void;
  emptyTitle: string;
  emptyDescription: string;
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
          emptyTitle={emptyTitle}
          emptyDescription={emptyDescription}
          onRowClick={onPilih}
        />
      </div>
      <div className="daftar-kartu">
        {rows.length === 0 ? (
          <AntreanKosong title={emptyTitle} description={emptyDescription} />
        ) : (
          <ul className="kartu-list">
            {rows.map((row) => {
              const isi = kartu(row);
              const key = rowKey(row);
              return (
                <li className="kartu-item" key={key}>
                  <button
                    type="button"
                    className="kartu-btn"
                    onClick={onPilih ? () => onPilih(row) : undefined}
                    disabled={!onPilih}
                  >
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
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

/**
 * True on a phone sized viewport. Read through matchMedia rather than through
 * a user agent string, because the question is how much room there is, not
 * what device this is. Falls back to "not small" where matchMedia does not
 * exist (the test DOM), which keeps the desktop layout as the default.
 */
export function useLayarKecil(): boolean {
  const [kecil, setKecil] = useState(() => {
    const mql = globalThis.matchMedia?.("(max-width: 640px)");
    return mql ? mql.matches : false;
  });

  useEffect(() => {
    const mql = globalThis.matchMedia?.("(max-width: 640px)");
    if (!mql) return;
    const onChange = (event: MediaQueryListEvent) => setKecil(event.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return kecil;
}

/**
 * The filter row on a desk, a sheet on a phone.
 *
 * A list page carries five filters and a search box. Inline, that is one
 * comfortable row on a monitor and an entire screen of controls before the
 * first row of data on a phone, which is the "shrunken desktop" the mobile
 * rules rule out. So on a small viewport the filters move behind one 44px
 * control that also says what is currently narrowing the list.
 */
export function Penyaring({
  ringkas,
  children,
}: {
  /** One line naming the active filters, shown on the phone trigger. */
  ringkas: string;
  children: ReactNode;
}) {
  const kecil = useLayarKecil();
  const [terbuka, setTerbuka] = useState(false);

  if (!kecil) return <>{children}</>;

  return (
    <div className="penyaring">
      <button type="button" className="penyaring-btn" onClick={() => setTerbuka(true)}>
        <Icon name="filter" size={18} />
        <span className="penyaring-teks">
          <span className="penyaring-judul">Filter dan pencarian</span>
          <span className="penyaring-ringkas">{ringkas}</span>
        </span>
        <Icon name="chevronRight" size={16} />
      </button>
      <Modal
        open={terbuka}
        title="Filter daftar"
        description="Perubahan filter langsung diterapkan pada daftar di belakang lembar ini."
        onClose={() => setTerbuka(false)}
        size="lg"
        actions={
          <Button variant="primary" onClick={() => setTerbuka(false)}>
            Terapkan
          </Button>
        }
      >
        {children}
      </Modal>
    </div>
  );
}
