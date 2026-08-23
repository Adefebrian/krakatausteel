// Bento grid primitive. Default layout system per jal-frontend-rules: one gap
// value per breakpoint, every card in a grid sharing one corner radius,
// padding, and border weight. Visual weight varies only by span, never by
// inconsistent chrome.
//
// The CSS lives in ./ui.css (imported once by the app's stylesheet) rather
// than in an exported template string, so there is exactly one copy of it.
import type { ReactNode } from "react";

export type BentoSpan = "sm" | "wide" | "tall" | "lg";

const spanClass: Record<BentoSpan, string> = {
  sm: "bento-sm",
  wide: "bento-wide",
  tall: "bento-tall",
  lg: "bento-lg",
};

export interface BentoProps {
  children: ReactNode;
  /** Column count on desktop. 4 by default, 2 for a narrower band. */
  columns?: 2 | 3 | 4;
  className?: string;
}

export function Bento({ children, columns = 4, className }: BentoProps) {
  const classes = ["bento", `bento-cols-${columns}`, className].filter(Boolean).join(" ");
  return <div className={classes}>{children}</div>;
}

export interface BentoItemProps {
  span?: BentoSpan;
  children: ReactNode;
  className?: string;
}

export function BentoItem({ span = "sm", children, className }: BentoItemProps) {
  const classes = ["bento-item", spanClass[span], className].filter(Boolean).join(" ");
  return <div className={classes}>{children}</div>;
}
