import { ChatsIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { Button } from "../ui/button.js";
import { WithTooltip } from "../ui/tooltip.js";

interface AttentionViewToggleProps {
  /** True when the sidebar is showing the needs-attention view. */
  active: boolean;
  /** Sessions needing attention RIGHT NOW — not the settled rows still listed. */
  count: number;
  onToggle: () => void;
  /** Tooltip side — the collapsed rail anchors to the right, like its siblings. */
  side?: "top" | "right";
}

/**
 * docs/260 — the switch between the sidebar's two views (req 1), carrying the
 * count of sessions that need attention (req 4).
 *
 * It sits in the header's LEFT slot beside the collapse control, not among the
 * session-creation controls on the right: the switch and the collapse button are
 * both controls for the sidebar itself, while the right-hand cluster is four
 * create/act controls the switch would be lost in.
 *
 * The count renders in BOTH views, because it is how the second view is
 * discovered from the first (req 5).
 *
 * Two deliberate choices in the treatment:
 *
 *  - **A pill, not a badge on a glyph.** The count sits beside the icon rather
 *    than on top of it, so it can never occlude the glyph — which is exactly
 *    what an earlier badge-over-fill draft did.
 *  - **The house toggle pattern, not a filled amber button.** `aria-pressed` +
 *    `weight="fill"` + a coloured glyph over a quiet `--color-bg-tertiary` chip,
 *    the same shape `IssuesViewer`'s "Show done" toggle uses. The sidebar header
 *    has no other filled control, and a saturated amber square read as an alert
 *    rather than a mode.
 *
 * Colour is `--color-attention-text`, not `--color-attention`: the marker amber
 * measures 2.35–2.89:1 as small text on the light themes' surfaces. See
 * `attention-contrast.test.ts` (req 16).
 */
export function AttentionViewToggle({ active, count, onToggle, side }: AttentionViewToggleProps) {
  // The label names the view the press goes TO. The count rides along in both
  // states — in the pressed one it is the only way a screen reader hears the
  // number the sighted user can see on the chip.
  const label = active
    ? count === 0
      ? "Show all sessions"
      : `Show all sessions (${count} need you)`
    : count === 0
      ? "Show sessions that need you"
      : `Show sessions that need you (${count})`;

  return (
    <WithTooltip label={label} side={side}>
      <Button
        variant="ghost"
        size="sm"
        onClick={onToggle}
        aria-pressed={active}
        aria-label={label}
        className={`px-1.5! h-7 gap-1 ${
          active
            ? "bg-(--color-bg-tertiary) text-(--color-attention-text)"
            : "text-(--color-text-tertiary)"
        }`}
      >
        <ChatsIcon size={ICON_SIZE.SM} weight={active ? "fill" : "regular"} className="shrink-0" />
        {count > 0 && (
          <span className="text-[10px] font-bold leading-none text-(--color-attention-text)">
            {count}
          </span>
        )}
      </Button>
    </WithTooltip>
  );
}
