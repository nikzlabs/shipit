import { forwardRef, type HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../utils/cn.js";

const bannerVariants = cva("text-xs", {
  variants: {

    variant: {
      error: "bg-(--color-error-subtle) text-(--color-error) border-(--color-error)",
      warning: "bg-(--color-warning-subtle) text-(--color-warning) border-(--color-warning)",
      info: "bg-(--color-info-subtle) text-(--color-info) border-(--color-info)",
      success: "bg-(--color-success-subtle) text-(--color-success) border-(--color-success)",
    },

    layout: {
      strip: "px-4 py-2 text-center font-medium",
      inline: "flex items-start gap-2 rounded-md border px-3 py-2",
    },
  },
  defaultVariants: {
    variant: "info",
    layout: "strip",
  },
});

export type BannerProps = HTMLAttributes<HTMLDivElement> &
  Omit<VariantProps<typeof bannerVariants>, "layout">;

export const Banner = forwardRef<HTMLDivElement, BannerProps>(
  ({ className, variant, ...props }, ref) => (
    <div
      ref={ref}

      className={cn(bannerVariants({ variant, layout: "strip" }), className)}
      {...props}
    />
  ),
);
Banner.displayName = "Banner";

export type AlertProps = HTMLAttributes<HTMLDivElement> &
  Omit<VariantProps<typeof bannerVariants>, "layout">;

export const Alert = forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(bannerVariants({ variant, layout: "inline" }), className)}
      {...props}
    />
  ),
);
Alert.displayName = "Alert";
