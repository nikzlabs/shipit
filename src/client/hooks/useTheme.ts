// eslint-disable-next-line no-restricted-imports -- useEffect: DOM class manipulation + localStorage persistence (external system sync)
import { useState, useEffect, useCallback } from "react";

/**
 * Theme type — "light" and "dark" are built-in; additional themes can be
 * added by creating a CSS file in `src/client/themes/`, importing it in
 * `index.css`, and registering the class name in `KNOWN_THEMES` below.
 */
export type Theme = "light" | "dark" | "midnight" | "forest" | "rose" | (string & {});

export interface ThemeOption {
  id: Theme;
  label: string;
  /** Short description shown in the picker */
  description: string;
}

export const THEME_OPTIONS: ThemeOption[] = [
  { id: "light", label: "Light", description: "Clean and bright" },
  { id: "dark", label: "Dark", description: "Classic dark mode" },
  { id: "midnight", label: "Midnight", description: "Deep blue tones" },
  { id: "forest", label: "Forest", description: "Green and earthy" },
  { id: "rose", label: "Rosé", description: "Warm pink and mauve" },
];

const STORAGE_KEY = "shipit-theme";

/** All theme class names that may be applied to <html>. */
const KNOWN_THEMES = ["dark", "midnight", "forest", "rose"] as const;

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
