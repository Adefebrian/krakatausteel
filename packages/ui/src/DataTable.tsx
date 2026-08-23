// DataTable. Dense, sortable, sticky header, presentational.
//
// It owns three things a page must never re-decide: how a money column is
// aligned and formatted (right, tabular figures, formatMoney), how a sort
// affordance looks, and what an empty or loading table shows. It does no
// fetching, no pagination, and no selection: those arrive with the phase that
// needs them.
import { useMemo, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { formatCount, formatDate, formatMoney, formatPercent } from "./money";

export type ColumnType = "text" | "money" | "count" | "percent" | "date" | "node";

export interface Column<Row> {
  /** Key into the row object. Also the sort key and the React key. */
  key: string;
  header: string;
  type?: ColumnType;
  sortable?: boolean;
  /** Fixed width, e.g. "120px". Omit to let the column size to content. */
  width?: string;
  /** Render override. Return a string or a node. */
  render?: (row: Row) => ReactNode;
  /** Sort value override, for a column whose display value is not sortable. */
  sortValue?: (row: Row) => string | number;
  /** Footer cell, e.g. a column total. */
  footer?: ReactNode;
}

export type SortDirection = "asc" | "desc";

export interface DataTableProps<Row> {
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  /** Stable row identity. Falls back to the row index. */
  rowKey?: (row: Row, index: number) => string;
  caption?: string;
  /** Shown in place of the body when there are no rows. */
  emptyTitle?: string;
  emptyDescription?: string;
  loading?: boolean;
  /** Sticky header. On by default, which is the point of a long ledger. */
  stickyHeader?: boolean;
  /** Controlled sort. Leave unset to let the table sort itself. */
  sort?: { key: string; direction: SortDirection };
  onSortChange?: (sort: { key: string; direction: SortDirection }) => void;
  /** Row click handler, used for drill down. */
  onRowClick?: (row: Row) => void;
  className?: string;
}

const NUMERIC_TYPES: ReadonlySet<ColumnType> = new Set(["money", "count", "percent"]);

function cellText<Row>(column: Column<Row>, row: Row): ReactNode {
  if (column.render) return column.render(row);
  const raw = (row as Record<string, unknown>)[column.key];
  switch (column.type) {
    case "money":
      return formatMoney(raw as number | string | null | undefined);
    case "count":
      return formatCount(raw as number | string | null | undefined);
    case "percent":
      return formatPercent(raw as number | string | null | undefined);
    case "date":
      return formatDate(raw as string | null | undefined);
    default:
      return raw === null || raw === undefined ? "" : String(raw);
  }
}

function sortKeyOf<Row>(column: Column<Row>, row: Row): string | number {
  if (column.sortValue) return column.sortValue(row);
  const raw = (row as Record<string, unknown>)[column.key];
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "number") return raw;
  if (NUMERIC_TYPES.has(column.type ?? "text")) {
    const parsed = Number(String(raw));
    return Number.isNaN(parsed) ? String(raw) : parsed;
  }
  return String(raw);
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  caption,
  emptyTitle = "Belum ada data",
  emptyDescription,
  loading = false,
  stickyHeader = true,
  sort,
  onSortChange,
  onRowClick,
  className,
}: DataTableProps<Row>) {
  const [internalSort, setInternalSort] = useState<{ key: string; direction: SortDirection } | null>(
    null,
  );
  const activeSort = sort ?? internalSort;

  const sortedRows = useMemo(() => {
    if (!activeSort) return rows;
    const column = columns.find((candidate) => candidate.key === activeSort.key);
    if (!column) return rows;
    const factor = activeSort.direction === "asc" ? 1 : -1;
    return [...rows].sort((left, right) => {
      const a = sortKeyOf(column, left);
      const b = sortKeyOf(column, right);
      if (typeof a === "number" && typeof b === "number") return (a - b) * factor;
      return String(a).localeCompare(String(b), "id") * factor;
    });
  }, [rows, columns, activeSort]);

  function toggleSort(key: string) {
    const next: { key: string; direction: SortDirection } =
      activeSort && activeSort.key === key
        ? { key, direction: activeSort.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "asc" };
    if (onSortChange) onSortChange(next);
    if (!sort) setInternalSort(next);
  }

  const hasFooter = columns.some((column) => column.footer !== undefined);
  const classes = [
    "table-wrap",
    stickyHeader ? "has-sticky-header" : null,
    onRowClick ? "has-row-click" : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes}>
      <table className="table">
        {caption ? <caption className="table-caption">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((column) => {
              const numeric = NUMERIC_TYPES.has(column.type ?? "text");
              const isActive = activeSort?.key === column.key;
              const ariaSort = isActive
                ? activeSort.direction === "asc"
                  ? "ascending"
                  : "descending"
                : undefined;
              return (
                <th
                  key={column.key}
                  scope="col"
                  style={column.width ? { width: column.width } : undefined}
                  className={numeric ? "is-numeric" : undefined}
                  aria-sort={ariaSort}
                >
                  {column.sortable ? (
                    <button
                      type="button"
                      className={isActive ? "th-sort is-active" : "th-sort"}
                      onClick={() => toggleSort(column.key)}
                    >
                      <span>{column.header}</span>
                      <Icon
                        name={isActive && activeSort.direction === "desc" ? "chevronDown" : "chevronUp"}
                        size={14}
                      />
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr className="table-state">
              <td colSpan={columns.length}>
                <span className="table-state-title">Memuat data</span>
              </td>
            </tr>
          ) : sortedRows.length === 0 ? (
            <tr className="table-state">
              <td colSpan={columns.length}>
                <span className="table-state-title">{emptyTitle}</span>
                {emptyDescription ? (
                  <span className="table-state-desc">{emptyDescription}</span>
                ) : null}
              </td>
            </tr>
          ) : (
            sortedRows.map((row, index) => (
              <tr
                key={rowKey ? rowKey(row, index) : String(index)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={NUMERIC_TYPES.has(column.type ?? "text") ? "is-numeric" : undefined}
                  >
                    {cellText(column, row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
        {hasFooter && sortedRows.length > 0 ? (
          <tfoot>
            <tr>
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={NUMERIC_TYPES.has(column.type ?? "text") ? "is-numeric" : undefined}
                >
                  {column.footer ?? ""}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}
