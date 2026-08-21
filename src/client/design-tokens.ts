/** Icon sizes — use these instead of magic numbers in Phosphor icon props. */
export const ICON_SIZE = {
  /** Compact badges (12px) */
  XS: 12,
  /** Inline with text (16px) */
  SM: 16,
  /** Buttons, nav items (20px) */
  MD: 20,
  /** Empty states (32px) */
  LG: 32,
  /** Hero / illustrations (48px) */
  XL: 48,
} as const;

/** Auto-merge is informational, not a status. Keep it neutral across surfaces. */
export const AUTO_MERGE_ICON_CLASS = "text-(--color-text-secondary)";

/**
 * A focus ring drawn INSIDE the border box, for a borderless control that a
 * clipping ancestor would otherwise shave the ring off.
 *
 * **Every ordinary focus indicator is painted OUTSIDE the border box**, and that
 * is the bug this constant exists to fix. The UA's own `:focus-visible` outline
 * sits a pixel or two out; a Tailwind `ring-*` is a non-inset `box-shadow`, so
 * it does too. The composer's toolbar puts its pickers inside
 * `overflow-hidden` groups (`wide-row-clip-group`, and the narrow row's
 * equivalent) whose content box hugs the buttons exactly — so the ring was shaved
 * off on all four sides and a picker read as having a broken selected state.
 *
 * Widening the group is not the alternative it looks like: any padding that
 * cleared the ring is also width the labels no longer get, and giving the labels
 * that width is precisely what the clipping is for (docs/260-composer-toolbar-layout req 1/8 — when the
 * row runs out of room the LABELS give way, rather than the row overflowing and
 * carrying Send off the edge).
 *
 * So the ring moves inward instead. `outline-none` suppresses the UA ring that
 * would otherwise still be there, clipped, beside ours.
 *
 * Use it for any control in those rows, not only the ones a group currently
 * clips: a toolbar where one button's focus ring is a different shape from its
 * neighbours' is its own defect, and which controls sit inside the clip group is
 * a layout detail that has already changed once.
 */
export const INSET_FOCUS_RING =
  "focus-visible:outline-none focus-visible:inset-ring-1 focus-visible:inset-ring-(--color-border-focus)";
