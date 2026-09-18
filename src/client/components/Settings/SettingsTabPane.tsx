import type { ReactNode } from "react";
import { cn } from "../../utils/cn.js";

/** A settings tab's scrolling body. */
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
