import type { ReactNode } from "react";
import { cn } from "../../utils/cn.js";

/**
 * Shell for a settings tab whose edits are committed with a Save button.
 *
 * The action bar sits **outside** the scroll container, so it stays pinned to
 * the bottom of the tab however far the body scrolls. Tabs used to end with a
 * plain row of buttons inside the scrolling area, which pushed Save out of
 * sight on a long form — the user had to scroll to the end to find out that
 * their edits were still unsaved.
 *
 * Tabs without a tab-level Save (Services, Advanced, Voice) keep their own
 * scroll container: their buttons are section-scoped and belong next to the
 * field they act on, not in a footer.
 */
export function SettingsTabPane({
  children,
  footer,
  bodyClassName,
  testId,
}: {
  children: ReactNode;
  /** Action bar content — rendered right-aligned in the pinned footer. */
  footer?: ReactNode;
  /** Extra classes for the scrolling body (spacing, gap). */
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
