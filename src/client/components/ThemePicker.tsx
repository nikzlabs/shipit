// eslint-disable-next-line no-restricted-imports -- useEffect: document mousedown listener for click-outside with cleanup (browser API subscription)
import { useState, useRef, useEffect } from "react";
import { PaletteIcon, CheckIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { THEME_OPTIONS, type Theme } from "../hooks/useTheme.js";

/** Preview swatch colors for each theme (bg-primary, accent, bg-secondary). */
const SWATCHES: Record<string, [string, string, string]> = {
  light: ["#ffffff", "#2563eb", "#f9fafb"],
  "warm-light": ["#fdf8f0", "#c07828", "#f5ede0"],
  "cool-light": ["#f4f6fa", "#4f46e5", "#e8ecf4"],
  dark: ["#030712", "#3b82f6", "#111827"],
  slate: ["#0f1219", "#5090d0", "#181d28"],
  midnight: ["#0b1120", "#5b8af7", "#121d33"],
  forest: ["#0c1410", "#34d399", "#131f19"],
  rose: ["#150c14", "#ec4899", "#1f1320"],
  claude: ["#1a1410", "#d97757", "#231c16"],
  codex: ["#0a0e0a", "#38c870", "#111a11"],
  solarized: ["#002b36", "#b58900", "#073642"],
  "high-contrast": ["#000000", "#00d4ff", "#0a0a0a"],
};

interface ThemePickerProps {
  theme: Theme;
  onSelectTheme: (theme: Theme) => void;
}

export function ThemePicker({ theme, onSelectTheme }: ThemePickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(!open)}
        title="Change theme"
        aria-label="Change theme"
      >
        <PaletteIcon size={ICON_SIZE.SM} />
      </Button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-52 max-h-80 overflow-y-auto bg-(--color-bg-elevated) border border-(--color-border-primary) rounded-lg shadow-lg z-50 py-1">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              onClick={() => {
                onSelectTheme(opt.id);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 text-xs hover:bg-(--color-bg-hover) text-(--color-text-primary) flex items-center gap-2.5"
            >
              {/* Color swatch */}
              <span className="flex gap-0.5 shrink-0">
                {(SWATCHES[opt.id] ?? ["#888", "#888", "#888"]).map(
                  (color, i) => (
                    <span
                      key={i}
                      className="w-3 h-3 rounded-sm border border-white/10"
                      style={{ backgroundColor: color }}
                    />
                  ),
                )}
              </span>
              <span className="flex-1 min-w-0">
                <span className="font-medium">{opt.label}</span>
                <span className="block text-(--color-text-secondary) mt-0.5">
                  {opt.description}
                </span>
              </span>
              {theme === opt.id && (
                <CheckIcon
                  size={ICON_SIZE.SM}
                  className="text-(--color-accent) shrink-0"
                />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
