import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";

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

  icon: ReactNode;

  label: string;

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
      <span className="group-data-[collapsed=true]/tabs:hidden">{label}</span>
      {badge}
    </button>
  ),
);
Tab.displayName = "Tab";
