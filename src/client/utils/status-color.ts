/**
 * Contrast-adaptive status colors (docs/170).
 *
 * Trackers hand us each status's own color (Linear's per-state hex), but those
 * are tuned for the tracker's UI — several Linear defaults (Backlog/Todo/
 * Duplicate) are near-white grays that vanish on a light theme, and a light
 * accent like "In Progress" yellow is barely there on white too. Rather than a
 * fixed outline ring (which only papers over the edge) we correct the color at
 * the source: keep its hue + saturation and nudge its LIGHTNESS away from the
 * surface — darker on a light surface, lighter on a dark one — by the minimum
 * needed to clear a target contrast ratio. Colors that already read fine (e.g.
 * a dark indigo "Done") come back untouched. The same status therefore shows a
 * darker shade on a light theme and a brighter one on a dark theme, and the dot
 * needs no ring because the fill itself now contrasts.
 *
 * Only hex colors are adapted; CSS-var tokens (priority colors, type fallbacks)
 * pass through unchanged — those are already theme-tuned by their `--color-*`.
 */

/** Minimum contrast ratio a status color must reach against its surface. */
const TARGET_CONTRAST = 1.8;

function hexToRgb(hex: string): [number, number, number] | null {
  const s = hex.trim().replace(/^#/, "");
  const full = s.length === 3 ? s.replace(/(.)/g, "$1$1") : s;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h: number;
  switch (mx) {
    case r:
      h = (g - b) / d + (g < b ? 6 : 0);
      break;
    case g:
      h = (b - r) / d + 2;
      break;
    default:
      h = (r - g) / d + 4;
  }
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

function channelLin(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of an sRGB triple. */
function relLum(r: number, g: number, b: number): number {
  return 0.2126 * channelLin(r) + 0.7152 * channelLin(g) + 0.0722 * channelLin(b);
}

/** WCAG contrast ratio between two relative luminances. */
function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Relative luminance of a CSS color string (hex or `rgb()`); 1 (light) if unparseable. */
export function luminanceOfCssColor(css: string): number {
  const s = css.trim();
  let rgb = hexToRgb(s);
  if (!rgb) {
    const m = /rgba?\(([^)]+)\)/i.exec(s);
    if (m) {
      const p = m[1].split(/[ ,/]+/).map(Number);
      if (p.length >= 3 && p.slice(0, 3).every((n) => !Number.isNaN(n))) rgb = [p[0], p[1], p[2]];
    }
  }
  return rgb ? relLum(rgb[0], rgb[1], rgb[2]) : 1;
}

const cache = new Map<string, string>();

/**
 * Adapt a status color so it reads against a surface of the given luminance.
 * Non-hex inputs (CSS-var tokens) are returned unchanged. Memoized by
 * (color, surface, target) — the set of distinct combinations is tiny.
 */
export function adaptColorForSurface(color: string, surfaceLum: number, target = TARGET_CONTRAST): string {
  const rgb = hexToRgb(color);
  if (!rgb) return color;
  const key = `${color}|${surfaceLum.toFixed(3)}|${target}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const [h, s] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  let [, , l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  const dir = surfaceLum > 0.4 ? -1 : 1; // light surface → darken; dark surface → lighten
  let cur = rgb;
  for (let i = 0; i < 60 && contrast(relLum(cur[0], cur[1], cur[2]), surfaceLum) < target; i++) {
    l = Math.min(1, Math.max(0, l + dir * 0.02));
    cur = hslToRgb(h, s, l);
    if (l === 0 || l === 1) break;
  }
  const out = rgbToHex(cur[0], cur[1], cur[2]);
  cache.set(key, out);
  return out;
}
