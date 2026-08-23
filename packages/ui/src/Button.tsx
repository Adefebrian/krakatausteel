// Button. Presentational, no dependency beyond React.
//
// All eight states are covered: default, hover, focus-visible, active,
// disabled, loading, error (variant "danger"), and success (variant
// "success" plus the confirmed label a caller passes in). The loading state
// keeps the button mounted at its resting width so the layout does not jump.
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "md" | "sm";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows the busy affordance and blocks the click. */
  loading?: boolean;
  /** Copy shown while loading. Defaults to "Memproses". */
  loadingLabel?: string;
  /** Stretch to the container width, for a form's submit row on mobile. */
  block?: boolean;
  leading?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  loadingLabel = "Memproses",
  block = false,
  leading,
  children,
  className,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  const classes = [
    "btn",
    `btn-${variant}`,
    size === "sm" ? "btn-sm" : null,
    block ? "btn-block" : null,
    loading ? "is-loading" : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {leading && !loading ? <span className="btn-leading">{leading}</span> : null}
      <span className="btn-label">{loading ? loadingLabel : children}</span>
    </button>
  );
}
