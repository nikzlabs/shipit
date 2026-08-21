import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "../../utils/cn.js";

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = forwardRef<
  ComponentRef<typeof TooltipPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 overflow-hidden rounded-md border border-(--color-border-secondary) bg-(--color-bg-elevated) px-3 py-1.5 text-xs text-(--color-text-primary) shadow-lg",
        "animate-in fade-in-0 zoom-in-95",
        "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

/** Convenience wrapper: wraps a single child element with a Radix tooltip.
 *  Includes its own TooltipProvider so it works in isolation (e.g. tests).
 *
 *  `label` is a `ReactNode`, not a string: docs/252's compacted routing band
 *  moves each option's name AND its explanation into the option's own tooltip,
 *  which needs the name on a bold first line. A `title` attribute cannot do
 *  that, and — the reason the band uses this at all — a `title` never opens on
 *  keyboard focus, so the copy the compaction promised to keep would be
 *  unreachable without a mouse. */
function WithTooltip({
  label,
  side,
  children,
}: {
  label: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  children: React.ReactNode;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side}>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, WithTooltip };
