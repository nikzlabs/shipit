import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";

const buttonVariants = cva(
  "inline-flex items-center justify-center rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
  {
    variants: {
      variant: {
        primary: "bg-(--color-accent) hover:bg-(--color-accent-hover) text-(--color-accent-text)",
        secondary: "bg-(--color-bg-tertiary) hover:bg-(--color-bg-hover) text-(--color-text-primary) border border-(--color-border-secondary)",
        destructive: "bg-(--color-error) hover:opacity-90 text-(--color-text-inverse)",
        ghost: "hover:bg-(--color-bg-hover) text-(--color-text-secondary) hover:text-(--color-text-primary)",
      },
      size: {
        sm: "text-xs px-2 py-1 gap-1",
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
      className={buttonVariants({ variant, size, className })}
      {...props}
    />
  ),
);
Button.displayName = "Button";
