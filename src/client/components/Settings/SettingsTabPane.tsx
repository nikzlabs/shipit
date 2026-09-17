import type { ReactNode } from "react";
import { cn } from "../../utils/cn.js";

/**
 * A settings tab's scrolling body.
 *
 * It had a `footer` slot for a tab's Save until the renderer took over placing
 * that (docs/308-data-driven-settings slice 9), and nothing else ever used one;
 * a prop with no caller is worse than none.
 */
export function SettingsTabPane({
  children,
  bodyClassName,
  testId,
}: {
  children: ReactNode;
  bodyClassName?: string;
  testId?: string;
}) {
  return (
    <div className="flex flex-col h-full min-h-0" data-testid={testId}>
      <div className={cn("flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-4", bodyClassName)}>
        {children}
      </div>
    </div>
  );
}
