/**
 * docs/252 req 19/21 — **one row shape for every credential**: `label · quota · ⋯`.
 *
 * Both delivery shapes render through this. Before it, an account row was a
 * permanently-mounted rename input over the account's UUID, with a status pill
 * and three ghost buttons beside it (≈120px), and a supplied-key row was a
 * label with *Replace* and a bin (39px) — two row languages inside one card,
 * for two things the user thinks of as the same thing. Now both are 28px of
 * one line, and everything that was a permanent control is behind the `⋯`.
 *
 * **A healthy row says nothing about its health.** An earlier mock-up put a
 * `StatusDot` on every row — green for ready, amber otherwise — which is the
 * wrong instinct twice: a green dot on the normal case is decoration repeated
 * once per row, restating what the absence of a problem already says, and a hue
 * alone is not a message a colour-blind user or a monochrome theme can read. So
 * `status` here is a WORD, and it is only ever passed for a state that needs
 * attention.
 *
 * The row owns no verbs. What the `⋯` holds, what happens on a drop, and where
 * an error goes are all the caller's — an account row and a key row genuinely
 * differ there, and that difference is the only one left between them.
 */

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
  /**
   * The one word a row says about itself, and ONLY when something needs doing
   * — "reconnect needed", "signing in…". A ready credential passes nothing.
   */
  status?: { text: string; tone: "warning" | "error" };
  /** The quota read-out — `SubscriptionLimitPill`, or nothing for a key. */
  quota?: ReactNode;
  /** `DropdownMenuItem`s. Absent while the row has no verbs available. */
  menu?: ReactNode;
  menuLabel: string;
  /** Drag handle + drop-target props, from {@link useRowDrag}. Absent below two rows. */
  drag?: RowDragProps;
  /** A failure this row produced (docs/257 req 5), under the line it belongs to. */
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
          // The grip is the whole drag affordance, and it is `draggable`
          // rather than the row: a row-wide drag start swallows the text
          // selection and the click that opens the `⋯`.
          <span
            {...drag.handle}
            className="shrink-0 cursor-grab text-(--color-text-tertiary) active:cursor-grabbing"
            data-testid={`${testId}-grip`}
          >
            <DotsSixVerticalIcon size={ICON_SIZE.SM} />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-(--color-text-primary)">{label}</span>
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
