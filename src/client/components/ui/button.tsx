import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../utils/cn.js";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
  {
    variants: {
      variant: {
        primary: "bg-(--color-accent) hover:bg-(--color-accent-hover) text-(--color-accent-text)",
        secondary: "bg-(--color-bg-tertiary) hover:bg-(--color-bg-hover) text-(--color-text-primary) border border-(--color-border-secondary)",
        destructive: "bg-(--color-error) hover:opacity-90 text-(--color-text-inverse)",
        ghost: "hover:bg-(--color-bg-hover) text-(--color-text-secondary) hover:text-(--color-text-primary)",
        // A calm-at-rest call-to-action: a subtle accent tint that fills to a
        // solid accent on hover. Designed for an action repeated down a list
        // (e.g. "Start session" per issue row) where a solid primary on every
        // row would be too loud. Border derived from the accent via color-mix so
        // it tracks every theme without a dedicated token.
        cta: "bg-(--color-accent-subtle) text-(--color-text-link) border border-[color-mix(in_oklab,var(--color-accent)_35%,transparent)] hover:bg-(--color-accent) hover:text-(--color-accent-text) hover:border-(--color-accent)",
      },
      size: {
        sm: "h-5 text-xs px-2 gap-1",
        md: "text-sm px-3 py-1.5 gap-1.5",
        lg: "text-sm px-4 py-2 gap-2",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      // Merge through twMerge so a caller's `className` reliably overrides the
      // variant/size utilities it conflicts with (CVA alone just concatenates,
      // leaving the winner to stylesheet source order).
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";
