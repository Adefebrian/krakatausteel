// EmptyState. Used both for a real empty list and for a Fase 0 placeholder
// page, so a screen never renders as a blank area with nothing to read.
//
// Honest by construction: `willContain` spells out what the page will hold, so
// a reviewer can check the build order against the spec instead of guessing.
import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  description?: string;
  /** Concrete list of what belongs here, rendered as a plain list. */
  willContain?: readonly string[];
  willContainLabel?: string;
  /** Primary next step, when there is one. */
  action?: ReactNode;
  footnote?: string;
}

export function EmptyState({
  icon = "list",
  title,
  description,
  willContain,
  willContainLabel = "Yang akan tersedia di halaman ini",
  action,
  footnote,
}: EmptyStateProps) {
  return (
    <div className="empty">
      <span className="empty-icon" aria-hidden="true">
        <Icon name={icon} size={22} />
      </span>
      <h2 className="empty-title">{title}</h2>
      {description ? <p className="empty-desc">{description}</p> : null}
      {willContain && willContain.length > 0 ? (
        <div className="empty-list-wrap">
          <p className="empty-list-label">{willContainLabel}</p>
          <ul className="empty-list">
            {willContain.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {action ? <div className="empty-action">{action}</div> : null}
      {footnote ? <p className="empty-footnote">{footnote}</p> : null}
    </div>
  );
}
