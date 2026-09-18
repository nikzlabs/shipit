import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../utils/cn.js";

/**
 * Exported so a control that must be a real `<a>` — anything the user should be
 * able to long-press, cmd/middle-click, or hand to the platform's own link
 * handling — can carry button styling without a `<button>` faking a link.
 */
export const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
  {
    variants: {
      variant: {
        primary: "bg-(--color-accent) hover:bg-(--color-accent-hover) text-(--color-accent-text)",
        secondary: "bg-(--color-bg-tertiary) hover:bg-(--color-bg-hover) text-(--color-text-primary) border border-(--color-border-secondary)",
        destructive: "bg-(--color-error) hover:opacity-90 text-(--color-text-inverse)",
        ghost: "hover:bg-(--color-bg-hover) text-(--color-text-secondary) hover:text-(--color-text-primary)",
        // A calm-at-rest call-to-action: a subtle accent tint that fills to a

        cta: "bg-(--color-accent-subtle) text-(--color-text-link) border border-[color-mix(in_oklab,var(--color-accent)_35%,transparent)] hover:bg-(--color-accent) hover:text-(--color-accent-text) hover:border-(--color-accent)",
      },
      size: {
        sm: "h-5 text-xs px-2 gap-1",

        md: "h-8 text-sm px-3 gap-1.5",
        lg: "text-sm px-4 py-2 gap-2",

        icon: "p-1 gap-1",
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

      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";
