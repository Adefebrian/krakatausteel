// Panel. The card shell every Bento cell uses, so card chrome (padding,
// radius, border weight) is identical across the product and only the content
// varies.
//
// The footer slot is pinned to the bottom of the card with margin-top:auto in
// ui.css, so a repeated element (a drill down link, a data source note) rests
// on one baseline across a whole row even when the titles wrap differently.
import type { ReactNode } from "react";

export interface PanelProps {
  title?: string;
  /** One line under the title. Keep it short, it is clamped to two lines. */
  description?: string;
  /** Right side of the title row, e.g. a StatusBadge or a small action. */
  aside?: ReactNode;
  /** Bottom pinned row, aligned across every card in a grid row. */
  footer?: ReactNode;
  /** Set when the body is a genuinely stretchable visual (a chart, a map). */
  stretchBody?: boolean;
  children?: ReactNode;
  className?: string;
  /** Heading level, so a page keeps one h1 and a sane outline. */
  as?: "h2" | "h3";
}

export function Panel({
  title,
  description,
  aside,
  footer,
  stretchBody = false,
  children,
  className,
  as: Heading = "h3",
}: PanelProps) {
  const classes = ["panel", className].filter(Boolean).join(" ");
  return (
    <section className={classes}>
      {title ? (
        <div className="panel-head">
          <div className="panel-headings">
            <Heading className="panel-title">{title}</Heading>
            {description ? <p className="panel-desc">{description}</p> : null}
          </div>
          {aside ? <div className="panel-aside">{aside}</div> : null}
        </div>
      ) : null}
      {children ? (
        <div className={stretchBody ? "panel-body is-stretch" : "panel-body"}>{children}</div>
      ) : null}
      {footer ? <div className="panel-foot">{footer}</div> : null}
    </section>
  );
}
