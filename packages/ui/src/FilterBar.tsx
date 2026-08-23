// FilterBar. Every list and every report in the catalog carries the same
// three filters (periode, cabang, pencarian), so they are declared once here
// and never re-laid-out per page. Presentational: the caller owns the state.
import type { ReactNode } from "react";
import { Button } from "./Button";
import { SearchInput, Select, type SelectOption } from "./FormField";
import { NAMA_BULAN } from "./money";

export interface PeriodeValue {
  tahun: number;
  bulan: number;
}

export interface FilterBarProps {
  periode?: PeriodeValue;
  onPeriodeChange?: (value: PeriodeValue) => void;
  /** Years offered in the periode selector, newest first. */
  tahunOptions?: readonly number[];

  cabang?: string;
  onCabangChange?: (value: string) => void;
  cabangOptions?: readonly SelectOption[];

  search?: string;
  onSearchChange?: (value: string) => void;
  searchLabel?: string;
  searchPlaceholder?: string;

  /** Extra filters specific to one page, e.g. sektor or status. */
  children?: ReactNode;
  onReset?: () => void;
}

export function FilterBar({
  periode,
  onPeriodeChange,
  tahunOptions,
  cabang,
  onCabangChange,
  cabangOptions,
  search,
  onSearchChange,
  searchLabel = "Cari",
  searchPlaceholder = "Cari nama atau nomor dokumen",
  children,
  onReset,
}: FilterBarProps) {
  const years =
    tahunOptions ??
    (periode ? [periode.tahun + 1, periode.tahun, periode.tahun - 1, periode.tahun - 2] : []);

  return (
    <div className="filterbar" role="search">
      {periode && onPeriodeChange ? (
        <div className="filterbar-group">
          <span className="filterbar-label">Periode</span>
          <div className="filterbar-pair">
            <Select
              aria-label="Bulan periode"
              value={String(periode.bulan)}
              onChange={(event) =>
                onPeriodeChange({ ...periode, bulan: Number(event.currentTarget.value) })
              }
              options={NAMA_BULAN.map((nama, index) => ({
                value: String(index + 1),
                label: nama,
              }))}
            />
            <Select
              aria-label="Tahun periode"
              value={String(periode.tahun)}
              onChange={(event) =>
                onPeriodeChange({ ...periode, tahun: Number(event.currentTarget.value) })
              }
              options={years.map((tahun) => ({ value: String(tahun), label: String(tahun) }))}
            />
          </div>
        </div>
      ) : null}

      {cabangOptions && onCabangChange ? (
        <div className="filterbar-group">
          <span className="filterbar-label">Cabang</span>
          <Select
            aria-label="Cabang"
            value={cabang ?? ""}
            onChange={(event) => onCabangChange(event.currentTarget.value)}
            options={cabangOptions}
          />
        </div>
      ) : null}

      {children}

      {onSearchChange ? (
        <div className="filterbar-group is-grow">
          <span className="filterbar-label">{searchLabel}</span>
          <SearchInput
            label={searchLabel}
            placeholder={searchPlaceholder}
            value={search ?? ""}
            onChange={(event) => onSearchChange(event.currentTarget.value)}
          />
        </div>
      ) : null}

      {onReset ? (
        <div className="filterbar-actions">
          <Button variant="secondary" onClick={onReset}>
            Atur ulang
          </Button>
        </div>
      ) : null}
    </div>
  );
}
