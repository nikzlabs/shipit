import { forwardRef, type HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";

const statusDotVariants = cva("inline-block w-2 h-2 rounded-full shrink-0", {
  variants: {
    status: {
      success: "bg-(--color-success)",
      error: "bg-(--color-error)",
      warning: "bg-(--color-warning)",
      info: "bg-(--color-info)",
    },
  },
  defaultVariants: {
    status: "info",
  },
});

export type StatusDotProps = HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof statusDotVariants>;

export const StatusDot = forwardRef<HTMLSpanElement, StatusDotProps>(
  ({ className, status, ...props }, ref) => (
    <span
      ref={ref}
      className={statusDotVariants({ status, className })}
      {...props}
    />
  ),
);
StatusDot.displayName = "StatusDot";
