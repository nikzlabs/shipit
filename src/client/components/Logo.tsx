/**
 * Logo — the ShipIt brand mark: the favicon image next to the "ShipIt"
 * wordmark, with "It" rendered in the brand accent red (#f0506e).
 *
 * Single source of truth for the wordmark. The `size` enum drives icon and
 * text together so the two stay proportional (~1.1 icon:text ratio):
 *   - "md" — top bar / chrome (icon 20px, text 18px)
 *   - "lg" — hero surfaces like onboarding (icon 30px, text 27px)
 * Wrapper extras go through `className`; `textClassName` extends the wordmark
 * styling (e.g. an explicit color) without disturbing the size's font metrics.
 */
import { cn } from "../utils/cn.js";

/** ShipIt brand accent — the red applied to "It". */
export const BRAND_ACCENT = "#f0506e";

export type LogoSize = "md" | "lg";

const SIZES: Record<LogoSize, { icon: string; text: string; gap: string }> = {
  md: {
    icon: "w-5 h-5",
    // Responsive shrink preserves the original top-bar behavior on mobile.
    text: "text-base sm:text-lg font-semibold tracking-tight",
    gap: "gap-1.5",
  },
  lg: {
    icon: "w-[30px] h-[30px] rounded-lg",
    text: "text-[27px] font-bold tracking-tight",
    gap: "gap-2.5",
  },
};

export function Logo({
  size = "md",
  className,
  textClassName,
}: {
  /** Lockup size preset. Defaults to "md" (top bar / chrome). */
  size?: LogoSize;
  /** Wrapper classes (extra layout). */
  className?: string;
  /** Extra classes for the wordmark <span> — e.g. an explicit text color. */
  textClassName?: string;
}) {
  const s = SIZES[size];
  return (
    <span className={cn("inline-flex items-center", s.gap, className)}>
      <img src="/favicon.svg" alt="" className={s.icon} />
      <span className={cn(s.text, textClassName)}>
        Ship<span style={{ color: BRAND_ACCENT }}>It</span>
      </span>
    </span>
  );
}
