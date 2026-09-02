/**
 * Spinner — the one in-flight indicator (docs/265).
 *
 * Twelve fixed spokes with a rotating opacity stagger, styled by `.spinner` in
 * `index.css`. It replaced `<CircleNotchIcon className="animate-spin" />` at
 * every call site for a measured reason, not a visual one: a `transform`
 * animation forces Chrome to recompute every live IntersectionObserver, so it
 * costs a full main-thread rendering pass per frame it produces, while an
 * `opacity` animation costs none at all. Smooth here is cheaper than the stepped
 * rotation it replaced — see the rule comment above `@theme` in `index.css`.
 *
 * It takes the same `size` numbers as the Phosphor icons (`ICON_SIZE`) and the
 * same `text-(--color-*)` classes, because the spokes paint in `currentColor`.
 */

import { ICON_SIZE } from "../design-tokens.js";

/**
 * Twelve spokes. They carry no props: `.spinner > i:nth-child(n)` in `index.css`
 * gives each one its angle and its keyframes, so the count is fixed by that
 * stylesheet and changing it here alone would leave the extras unstyled.
 */
const SPOKES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

interface SpinnerProps {
  /** Diameter in px. Defaults to `ICON_SIZE.SM`, matching an inline icon. */
  size?: number;
  /** Extra classes — colour (`text-(--color-*)`), margins, `shrink-0`. */
  className?: string;
  /** Accessible label. Omitted by default: most spinners sit beside their own text. */
  label?: string;
}

export function Spinner({ size = ICON_SIZE.SM, className = "", label }: SpinnerProps) {
  return (
    <span
      className={`spinner ${className}`}
      style={{ width: size, height: size }}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-testid="spinner"
    >
      {SPOKES.map((i) => <i key={i} />)}
    </span>
  );
}
