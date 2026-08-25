// DataList. The label and value pairs that make up every detail panel in the
// product: proposal identity, akad terms, mitra profile, survey result.
//
// One component so the label column, the value alignment, and the wrap
// behaviour are identical on every card. A money value passes `numeric` and
// gets the tabular figures and the right alignment the accounting tables use,
// so a figure on a detail card and the same figure in a table line up.
import type { ReactNode } from "react";

export interface DataListItem {
  label: string;
  value: ReactNode;
  /** Right aligned tabular figures, for money and counts. */
  numeric?: boolean;
  /** Spans the full width, for an address or a long note. */
  wide?: boolean;
}

export interface DataListProps {
  items: readonly DataListItem[];
  /** 1 on a narrow card, 2 on a wide one. Always 1 on mobile. */
  columns?: 1 | 2;
}

export function DataList({ items, columns = 1 }: DataListProps) {
  return (
    <dl className={`datalist datalist-cols-${columns}`}>
      {items.map((item) => (
        <div
          className={item.wide ? "datalist-row is-wide" : "datalist-row"}
          key={item.label}
        >
          <dt className="datalist-key">{item.label}</dt>
          <dd className={item.numeric ? "datalist-val is-numeric" : "datalist-val"}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
