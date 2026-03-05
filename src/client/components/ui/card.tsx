import { forwardRef, type HTMLAttributes } from "react";

export type CardProps = HTMLAttributes<HTMLDivElement>;

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={`border border-(--color-border-primary) bg-(--color-bg-elevated) rounded-lg shadow-sm ${className ?? ""}`}
      {...props}
    />
  ),
);
Card.displayName = "Card";
