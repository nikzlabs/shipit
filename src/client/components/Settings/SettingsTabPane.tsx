import type { ReactNode } from "react";
import { cn } from "../../utils/cn.js";

export function SettingsTabPane({
  children,
  footer,
  bodyClassName,
  testId,
}: {
  children: ReactNode;

  footer?: ReactNode;

  bodyClassName?: string;
  testId?: string;
}) {
  return (
    <div className="flex flex-col h-full min-h-0" data-testid={testId}>
      <div className={cn("flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-4", bodyClassName)}>
        {children}
      </div>
      {footer && (
        <div className="shrink-0 flex items-center justify-end gap-2 border-t border-(--color-border-secondary) bg-(--color-bg-elevated) px-5 py-3">
          {footer}
        </div>
      )}
    </div>
  );
}
