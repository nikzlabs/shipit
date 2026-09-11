

import type { ReactNode } from "react";
import { DotsSixVerticalIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { OverflowMenu } from "../ui/overflow-menu.js";
import type { RowDragProps } from "./useRowDrag.js";

export function CredentialRowShell({
  label,
  status,
  quota,
  menu,
  menuLabel,
  drag,
  error,
  children,
  testId,
}: {
  label: string;

  status?: { text: string; tone: "warning" | "error" };

  quota?: ReactNode;

  menu?: ReactNode;
  menuLabel: string;

  drag?: RowDragProps;

  error?: ReactNode;
  /** Anything the row must open *below* itself — a rename field, a paste field. */
  children?: ReactNode;
  testId: string;
}) {
  return (
    <div
      {...(drag?.container ?? {})}
      className={`rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) px-1.5 py-1 ${
        drag?.isDragging ? "opacity-40" : ""
      } ${drag?.isOver ? "border-(--color-accent)" : ""}`}
      data-testid={testId}
    >
      <div className="flex min-h-6 items-center gap-1.5">
        {drag && (

          <span
            {...drag.handle}
            className="shrink-0 cursor-grab text-(--color-text-tertiary) active:cursor-grabbing"
            data-testid={`${testId}-grip`}
          >
            <DotsSixVerticalIcon size={ICON_SIZE.SM} />
          </span>
        )}
        {/*
          **The label wraps; it is never cut.** It is the only thing naming
          which credential this row is — "Anthropic (ANTHROPIC_AUTH_TOKEN)" and
          "Anthropic (ANTHROPIC_API_KEY)" differ at the end, so an ellipsis
          there leaves two rows reading identically. A narrow panel takes a
          second line rather than the name; the quota and the `⋯` keep their
          places on the first, being `shrink-0`.
        */}
        <span className="min-w-0 flex-1 break-words text-xs text-(--color-text-primary)">{label}</span>
        {status && (
          <span
            className={`shrink-0 text-[11px] ${
              status.tone === "error" ? "text-(--color-error)" : "text-(--color-warning)"
            }`}
            data-testid={`${testId}-status`}
          >
            {status.text}
          </span>
        )}
        {quota}
        {menu && (
          <OverflowMenu
            label={menuLabel}
            triggerClassName="h-6 w-6 shrink-0"
            contentClassName="min-w-40"
          >
            {menu}
          </OverflowMenu>
        )}
      </div>
      {error}
      {children}
    </div>
  );
}
