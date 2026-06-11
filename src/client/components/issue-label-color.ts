/**
 * Deterministic per-label color for the Issues tab label chips.
 *
 * Neither tracker hands us a label color on the list path — `TrackerIssue.labels`
 * is just display names (SHI-92). Rather than render every chip in the same flat
 * gray, we derive a stable hue from the label name so "bug", "design",
 * "infra" each get their own consistent dot color across rows and sessions.
 *
 * The hue drives only a small dot, never the chip's text or background, so the
 * result stays legible in every theme (the text uses design tokens). Fixed
 * saturation/lightness keep the dots vivid-but-muted in both light and dark.
 */

/** FNV-1a-ish hash of the label name, folded to a 0–359 hue. */
export function labelHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

/** A theme-stable dot color for a label, as an `hsl()` string. */
export function labelDotColor(name: string): string {
  return `hsl(${labelHue(name)} 60% 55%)`;
}
