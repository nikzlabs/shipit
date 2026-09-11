import { forwardRef, type HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../utils/cn.js";

const badgeVariants = cva(
  "inline-flex items-center rounded-full text-xs font-medium px-2 py-0.5",
  {
    variants: {
      variant: {
        default: "bg-(--color-bg-tertiary) text-(--color-text-secondary)",
        success: "bg-(--color-success-subtle) text-(--color-success)",
        error: "bg-(--color-error-subtle) text-(--color-error)",
        warning: "bg-(--color-warning-subtle) text-(--color-warning)",
        info: "bg-(--color-info-subtle) text-(--color-info)",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export type BadgeProps = HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeVariants> & {

    numeric?: boolean;
  };

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, numeric, ...props }, ref) => (
    <span
      ref={ref}

      className={cn(badgeVariants({ variant }), numeric && "tabular-nums", className)}
      {...props}
    />
  ),
);
Badge.displayName = "Badge";
