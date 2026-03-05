/** Icon sizes — use these instead of magic numbers in Phosphor icon props. */
export const ICON_SIZE = {
  /** Inline with text (16px) */
  SM: 16,
  /** Buttons, nav items (20px) */
  MD: 20,
  /** Empty states (32px) */
  LG: 32,
  /** Hero / illustrations (48px) */
  XL: 48,
} as const;

/** Font sizes for non-standard values not covered by Tailwind's scale. */
export const FONT_SIZE = {
  /** Code / monospace blocks (13px) */
  CODE: "13px",
} as const;
