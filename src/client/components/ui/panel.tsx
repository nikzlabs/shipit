import { forwardRef, type HTMLAttributes } from "react";

export type PanelProps = HTMLAttributes<HTMLDivElement>;

export const Panel = forwardRef<HTMLDivElement, PanelProps>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={`border border-(--color-border-primary) bg-(--color-bg-secondary) rounded-lg ${className ?? ""}`}
      {...props}
    />
  ),
);
Panel.displayName = "Panel";
