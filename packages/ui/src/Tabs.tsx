// Tabs. One horizontal switch between two or more views of the SAME list, and
// nothing else: it never navigates, it never fetches, the caller owns which
// panel is rendered.
//
// Spec 9.1 requires the proposal list to separate "Daftar Pemohon" from
// "Daftar Pemohon Online", and spec 9.2 requires the same split on Non PUMK,
// so the control is declared once here instead of being redrawn per page.
//
// Every tab is a real button at the 44px touch floor, the active one carries
// aria-selected as well as a visual state, and the optional count sits inside
// the same button so the tap target is one rectangle rather than two.
import type { ReactNode } from "react";

export interface TabItem {
  id: string;
  label: string;
  /** Row count for this tab. Rendered next to the label when present. */
  count?: number;
  /** Rarely needed: a tab that exists but cannot be opened yet. */
  disabled?: boolean;
}

export interface TabsProps {
  items: readonly TabItem[];
  active: string;
  onChange: (id: string) => void;
  /** Accessible name for the tablist, e.g. "Sumber pengajuan". */
  label: string;
  /** Right side of the tab row, e.g. a small action. */
  aside?: ReactNode;
}

export function Tabs({ items, active, onChange, label, aside }: TabsProps) {
  return (
    <div className="tabs">
      <div className="tabs-list" role="tablist" aria-label={label}>
        {items.map((item) => {
          const selected = item.id === active;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`tab-${item.id}`}
              aria-selected={selected}
              aria-controls={`panel-${item.id}`}
              className={selected ? "tabs-tab is-active" : "tabs-tab"}
              disabled={item.disabled}
              onClick={() => onChange(item.id)}
            >
              <span className="tabs-label">{item.label}</span>
              {item.count === undefined ? null : (
                <span className="tabs-count">{item.count}</span>
              )}
            </button>
          );
        })}
      </div>
      {aside ? <div className="tabs-aside">{aside}</div> : null}
    </div>
  );
}

export interface TabPanelProps {
  id: string;
  children: ReactNode;
}

export function TabPanel({ id, children }: TabPanelProps) {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} className="tabs-panel">
      {children}
    </div>
  );
}
