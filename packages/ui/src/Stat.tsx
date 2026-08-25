// Stat. One figure with its name under it, for the top band of a detail page.
//
// The figure is passed in ALREADY FORMATTED, by formatMoney or formatRupiah,
// so this component owns no number policy at all and cannot become a second
// place where money is rendered. Pass `formatMoney(...)`, never a raw float.
import type { ReactNode } from "react";

export interface StatProps {
  label: string;
  /** Already formatted. Use formatMoney / formatRupiah / formatCount. */
  value: ReactNode;
  /** One short line under the figure, e.g. the date it was measured. */
  hint?: string;
  /** A StatusBadge or similar, next to the label. */
  aside?: ReactNode;
}

export function Stat({ label, value, hint, aside }: StatProps) {
  return (
    <div className="stat">
      <div className="stat-head">
        <span className="stat-label">{label}</span>
        {aside ? <span className="stat-aside">{aside}</span> : null}
      </div>
      <p className="stat-value">{value}</p>
      {hint ? <p className="stat-hint">{hint}</p> : null}
    </div>
  );
}
