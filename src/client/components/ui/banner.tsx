import { forwardRef, type HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../utils/cn.js";

const bannerVariants = cva("text-xs", {
  variants: {
    // The color tokens are shared by both layouts so the mapping lives in one
    // place. `border-*` only renders under the `inline` layout (which adds a
    // `border` width); it is an inert no-op in the borderless `strip` layout.
    variant: {
      error: "bg-(--color-error-subtle) text-(--color-error) border-(--color-error)",
      warning: "bg-(--color-warning-subtle) text-(--color-warning) border-(--color-warning)",
      info: "bg-(--color-info-subtle) text-(--color-info) border-(--color-info)",
      success: "bg-(--color-success-subtle) text-(--color-success) border-(--color-success)",
    },
    // strip: the full-width, centered, borderless status strip (`Banner`).
    // inline: a left-aligned icon + text callout box with a border (`Alert`).
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

/** Full-width, centered, borderless status strip. */
export const Banner = forwardRef<HTMLDivElement, BannerProps>(
  ({ className, variant, ...props }, ref) => (
    <div
      ref={ref}
      // Merge through twMerge so a caller's `className` reliably overrides the
      // variant utilities it conflicts with (CVA alone just concatenates).
      className={cn(bannerVariants({ variant, layout: "strip" }), className)}
      {...props}
    />
  ),
);
Banner.displayName = "Banner";

export type AlertProps = HTMLAttributes<HTMLDivElement> &
  Omit<VariantProps<typeof bannerVariants>, "layout">;

/**
 * Left-aligned, bordered icon + text callout box. Shares `Banner`'s color
 * tokens. Children supply the content (and any leading icon, as the first flex
 * child); they inherit the variant's `text-xs` color, so a sub-line that needs
 * a muted color overrides it explicitly.
 */
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
