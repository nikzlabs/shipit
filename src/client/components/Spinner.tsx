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

const SPOKES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

interface SpinnerProps {

  size?: number;

  className?: string;

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
