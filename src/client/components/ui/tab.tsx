import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";

/**
 * Tab — a single tab button for the right-panel tab bar (Preview / Docs / …).
 *
 * Renders a Phosphor icon followed by a label, with an accent underline on the
 * active tab. The label is hidden below the container's `@3xl` width (see the
 * `@container` on the tab bar) so a narrowed panel collapses to icon-only
 * instead of overflowing — the `aria-label`/`title` keep it accessible.
 *
 * The `pr` tone recolors the active underline + icon with `--color-pr` so the
 * contextual PR tab reads as distinct from the persistent views.
 */
const tabVariants = cva(
  "relative inline-flex items-center gap-1.5 h-full px-3 text-xs sm:text-sm font-medium border-b-2 transition-[color,border-color] duration-[var(--duration-fast)] whitespace-nowrap",
  {
    variants: {
      active: {
        true: "text-(--color-text-primary)",
        false: "text-(--color-text-secondary) hover:text-(--color-text-primary)",
      },
      tone: {
        accent: "",
        pr: "",
      },
    },
    compoundVariants: [
      { active: false, tone: ["accent", "pr"], className: "border-transparent" },
      { active: true, tone: "accent", className: "border-(--color-border-focus)" },
      { active: true, tone: "pr", className: "border-(--color-pr)" },
    ],
    defaultVariants: { active: false, tone: "accent" },
  },
);

export interface TabProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof tabVariants> {
  /** Phosphor icon element rendered before the label. */
  icon: ReactNode;
  /** Tab label; also the accessible name when collapsed to icon-only. */
  label: string;
  /** Optional trailing badge (e.g. an unseen count). */
  badge?: ReactNode;
}

export const Tab = forwardRef<HTMLButtonElement, TabProps>(
  ({ className, active, tone, icon, label, badge, ...props }, ref) => (
    <button
      ref={ref}
      aria-label={label}
      title={label}
      aria-current={active ? "page" : undefined}
      className={tabVariants({ active, tone, className })}
      {...props}
    >
      <span className={tone === "pr" && active ? "text-(--color-pr)" : undefined}>
        {icon}
      </span>
      <span className="hidden @3xl:inline">{label}</span>
      {badge}
    </button>
  ),
);
Tab.displayName = "Tab";
