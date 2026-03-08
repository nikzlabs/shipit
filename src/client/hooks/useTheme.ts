// eslint-disable-next-line no-restricted-imports -- useEffect: DOM class manipulation + localStorage persistence (external system sync)
import { useState, useEffect, useCallback } from "react";

/**
 * Single source of truth for all themes.
 * To add a theme: create a CSS file, import it in index.css, add an entry here.
 */
const THEME_DEFS = [
  { id: "light", label: "Light", description: "Clean and bright", light: true },
  { id: "warm-light", label: "Warm Light", description: "Cream and sand tones", light: true },
  { id: "cool-light", label: "Cool Light", description: "Blue-gray and indigo", light: true },
  { id: "solarized-light", label: "Solarized Light", description: "Classic cream and yellow", light: true },
  { id: "claude-light", label: "Claude Light", description: "Parchment and terracotta", light: true },
  { id: "codex-light", label: "Codex Light", description: "Mint and terminal green", light: true },
  { id: "dark", label: "Dark", description: "Classic dark mode", light: false },
  { id: "midnight", label: "Midnight", description: "Deep blue tones", light: false },
  { id: "forest", label: "Forest", description: "Green and earthy", light: false },
  { id: "rose", label: "Rosé", description: "Warm pink and mauve", light: false },
  { id: "claude", label: "Claude Dark", description: "Terracotta and warmth", light: false },
  { id: "codex", label: "Codex Dark", description: "Terminal green", light: false },
  { id: "solarized", label: "Solarized Dark", description: "Classic Solarized Dark", light: false },
  { id: "high-contrast", label: "High Contrast", description: "Maximum readability", light: false },
] as const;

// ── Derived types and collections (no duplication) ──

export type Theme = (typeof THEME_DEFS)[number]["id"] | (string & {});

export interface ThemeOption {
  id: Theme;
  label: string;
  description: string;
}

export const THEME_OPTIONS: ThemeOption[] = [...THEME_DEFS];

/** Themes that use a light background (need light favicon, etc.). */
export const LIGHT_THEMES = new Set<string>(
  THEME_DEFS.filter((t) => t.light).map((t) => t.id),
);

/** All theme class names that may be applied to <html>. */
const KNOWN_THEMES = THEME_DEFS.filter((t) => t.id !== "light").map((t) => t.id);

const STORAGE_KEY = "shipit-theme";

function getInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
  } catch {
    // localStorage unavailable
  }
  return "dark";
}

function applyTheme(theme: Theme): void {
  const cl = document.documentElement.classList;
  // Remove all known theme classes
  for (const t of KNOWN_THEMES) cl.remove(t);
  // Light = no class (:root defaults), others add their class name
  if (theme !== "light") {
    cl.add(theme);
  }
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // localStorage unavailable
    }
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  }, []);

  return { theme, toggle, setTheme };
}
