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
