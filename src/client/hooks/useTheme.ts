// eslint-disable-next-line no-restricted-imports -- useEffect: DOM class manipulation + localStorage persistence (external system sync)
import { useState, useEffect, useCallback } from "react";

/**
 * Theme type — "light" and "dark" are built-in; additional themes can be
 * added by creating a CSS file in `src/client/themes/`, importing it in
 * `index.css`, and registering the class name in `KNOWN_THEMES` below.
 */
export type Theme = "light" | "dark" | "midnight" | "forest" | "rose" | "claude" | "codex" | "warm-light" | "cool-light" | "slate" | "solarized" | "high-contrast" | (string & {});

export interface ThemeOption {
  id: Theme;
  label: string;
  /** Short description shown in the picker */
  description: string;
}

export const THEME_OPTIONS: ThemeOption[] = [
  { id: "light", label: "Light", description: "Clean and bright" },
  { id: "warm-light", label: "Warm Light", description: "Cream and sand tones" },
  { id: "cool-light", label: "Cool Light", description: "Blue-gray and indigo" },
  { id: "dark", label: "Dark", description: "Classic dark mode" },
  { id: "slate", label: "Slate", description: "Warm blue-gray dark" },
  { id: "midnight", label: "Midnight", description: "Deep blue tones" },
  { id: "forest", label: "Forest", description: "Green and earthy" },
  { id: "rose", label: "Rosé", description: "Warm pink and mauve" },
  { id: "claude", label: "Claude", description: "Terracotta and warmth" },
  { id: "codex", label: "Codex", description: "Terminal green" },
  { id: "solarized", label: "Solarized", description: "Classic Solarized Dark" },
  { id: "high-contrast", label: "High Contrast", description: "Maximum readability" },
];

const STORAGE_KEY = "shipit-theme";

/** All theme class names that may be applied to <html>. */
const KNOWN_THEMES = ["dark", "midnight", "forest", "rose", "claude", "codex", "warm-light", "cool-light", "slate", "solarized", "high-contrast"] as const;

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

/** Themes that use a light background (need light favicon, etc.). */
export const LIGHT_THEMES = new Set(["light", "warm-light", "cool-light"]);

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
