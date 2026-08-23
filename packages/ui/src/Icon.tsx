// Shared icon wrapper. Every icon in the product renders through this
// component so size, color token, and markup are enforced centrally, never
// scattered as inline SVG across pages.
//
// Sourcing order (see jal-frontend-rules):
//   1. The koboyo MCP is the first source. It was not reachable from the
//      build environment for this pass, so:
//   2. reicon.dev is the documented fallback. Its "Outline" weight glyphs are
//      generated into ./icon-data.ts by packages/ui/tools/gen-icons.py. Add a
//      new glyph by adding its name to that script's MAP and rerunning it,
//      never by pasting an SVG into a page.
//   3. Never hand-draw a glyph and never introduce a third icon family.
import type { CSSProperties } from "react";
import { ICON_PATHS, ICON_VIEWBOX, type IconName } from "./icon-data";

export type { IconName };

export interface IconProps {
  name: IconName;
  /** Pixel box. Defaults to 20, matching the body line box. */
  size?: number;
  /** Any color token. Defaults to inheriting the surrounding text color. */
  color?: string;
  /**
   * Accessible name. Omit it for a glyph that only decorates a label that is
   * already present in the DOM, so screen readers do not read it twice.
   */
  label?: string;
  className?: string;
}

export function Icon({ name, size = 20, color, label, className }: IconProps) {
  const paths = ICON_PATHS[name];
  const style: CSSProperties = color ? { color } : {};

  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={ICON_VIEWBOX}
      width={size}
      height={size}
      fill="none"
      style={style}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {paths.map((d) => (
        <path key={d.slice(0, 24)} d={d} fill="currentColor" fillRule="evenodd" clipRule="evenodd" />
      ))}
    </svg>
  );
}
