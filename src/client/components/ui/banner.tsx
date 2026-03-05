import { forwardRef, type HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";

const bannerVariants = cva(
  "px-4 py-2 text-xs text-center font-medium",
  {
    variants: {
      variant: {
        error: "bg-(--color-error-subtle) text-(--color-error)",
        warning: "bg-(--color-warning-subtle) text-(--color-warning)",
        info: "bg-(--color-info-subtle) text-(--color-info)",
        success: "bg-(--color-success-subtle) text-(--color-success)",
      },
    },
    defaultVariants: {
      variant: "info",
    },
  },
);

export type BannerProps = HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof bannerVariants>;

export const Banner = forwardRef<HTMLDivElement, BannerProps>(
  ({ className, variant, ...props }, ref) => (
    <div
      ref={ref}
      className={bannerVariants({ variant, className })}
      {...props}
    />
  ),
);
Banner.displayName = "Banner";
