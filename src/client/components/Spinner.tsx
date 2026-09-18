/**
 * Spinner — the one in-flight indicator (docs/265).
 *
 * A 270° comet arc that rotates, styled by `.spinner` in `index.css`. It draws
 * the shape `<CircleNotchIcon className="animate-spin" />` drew, but it may not
 * rotate the way that did: a `transform` animation forces Chrome to recompute
 * every live IntersectionObserver, so it costs a full main-thread rendering pass
 * per frame it produces, while an `opacity` animation costs none at all — the
 * rule comment above `@theme` in `index.css` has the measurements.
 *
 * So the arc is built from contiguous ring wedges that never move. Each holds a
 * fixed slice of the circle and only fades, and the arc is the envelope of their
 * opacities. Two things make that read as rotation rather than as flickering,
 * and both are load-bearing: the wedges TOUCH, so the lit run is one arc and not
 * a ring of dashes, and each one fades IN over the width of its neighbour, so
 * the bright head glides continuously instead of jumping from wedge to wedge.
 * The first opacity spinner had neither, and read as a 10 fps stepper even
 * though it drew at display rate. `Spinner.smoothness.test.ts` measures both out
 * of the shipped CSS, so neither can regress quietly.
 *
 * It takes the same `size` numbers as the Phosphor icons (`ICON_SIZE`) and the
 * same `text-(--color-*)` classes, because the wedges paint in `currentColor`.
 */

import { ICON_SIZE } from "../design-tokens.js";

const SPOKE_COUNT = 36;
const SPOKES = Array.from({ length: SPOKE_COUNT }, (_, i) => i);

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
