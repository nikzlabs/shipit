/**
 * Logo — the ShipIt brand mark: the favicon image next to the "ShipIt"
 * wordmark, with "It" rendered in the brand accent red (#f0506e).
 *
 * Single source of truth for the wordmark so the top bar, onboarding hero, and
 * any future surface stay in sync. Sizing is left to the caller via
 * `iconClassName`/`textClassName`; the wordmark text otherwise inherits font
 * styles from its parent (e.g. the header <h1>), so callers that don't pass
 * `textClassName` get the surrounding typography for free.
 */
import { cn } from "../utils/cn.js";

/** ShipIt brand accent — the red applied to "It". */
export const BRAND_ACCENT = "#f0506e";

export function Logo({
  className,
  iconClassName = "w-5 h-5",
  textClassName,
}: {
  /** Wrapper classes (layout, gap). Defaults to an inline flex row. */
  className?: string;
  /** Classes for the favicon <img> — controls size and corner rounding. */
  iconClassName?: string;
  /** Classes for the wordmark <span>. Omit to inherit parent typography. */
  textClassName?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <img src="/favicon.svg" alt="" className={iconClassName} />
      <span className={textClassName}>
        Ship<span style={{ color: BRAND_ACCENT }}>It</span>
      </span>
    </span>
  );
}
