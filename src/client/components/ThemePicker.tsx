// eslint-disable-next-line no-restricted-imports -- useEffect: document mousedown listener for click-outside with cleanup (browser API subscription)
import { useState, useRef, useEffect, useCallback } from "react";
import { PaletteIcon, CheckIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { THEME_OPTIONS, type Theme } from "../hooks/useTheme.js";

/** Preview colors: [bg, text, accent, secondaryText]. */
const PREVIEW: Record<string, [string, string, string, string]> = {
  light: ["#ffffff", "#111827", "#2563eb", "#4b5563"],
  "warm-light": ["#fdf8f0", "#2c2416", "#c07828", "#5c5040"],
  "cool-light": ["#f4f6fa", "#1a1e2e", "#4f46e5", "#454d64"],
  "solarized-light": ["#fdf6e3", "#073642", "#b58900", "#586e75"],
  "claude-light": ["#faf5ef", "#2a2018", "#d97757", "#5c5040"],
  dark: ["#030712", "#f3f4f6", "#3b82f6", "#9ca3af"],
  slate: ["#0f1219", "#e0e4ee", "#5090d0", "#8890a8"],
  midnight: ["#0b1120", "#e2e8f0", "#5b8af7", "#8494b0"],
  forest: ["#0c1410", "#e2ede6", "#34d399", "#7ca890"],
  rose: ["#150c14", "#f0e4ee", "#ec4899", "#a888a0"],
  claude: ["#1a1410", "#e8e0d8", "#d97757", "#a89a8c"],
  codex: ["#0a0e0a", "#c8e0c8", "#38c870", "#7aaa7a"],
  solarized: ["#002b36", "#eee8d5", "#b58900", "#93a1a1"],
  "high-contrast": ["#000000", "#ffffff", "#00d4ff", "#cccccc"],
};

const FALLBACK: [string, string, string, string] = [
  "#888",
  "#fff",
  "#888",
  "#aaa",
];

interface ThemePickerProps {
  theme: Theme;
  onSelectTheme: (theme: Theme) => void;
}

export function ThemePicker({ theme, onSelectTheme }: ThemePickerProps) {
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

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

  // Focus the active item when dropdown opens
  useEffect(() => {
    if (open) {
      const activeIndex = THEME_OPTIONS.findIndex((o) => o.id === theme);
      setFocusIndex(activeIndex >= 0 ? activeIndex : 0);
    }
  }, [open, theme]);

  // Scroll focused item into view
  useEffect(() => {
    if (open && focusIndex >= 0) {
      itemRefs.current[focusIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [open, focusIndex]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!open) return;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setFocusIndex((i) => (i + 1) % THEME_OPTIONS.length);
          break;
        case "ArrowUp":
          e.preventDefault();
          setFocusIndex(
            (i) => (i - 1 + THEME_OPTIONS.length) % THEME_OPTIONS.length,
          );
          break;
        case "ArrowRight":
          e.preventDefault();
          setFocusIndex((i) =>
            i + 1 < THEME_OPTIONS.length ? i + 1 : i,
          );
          break;
        case "ArrowLeft":
          e.preventDefault();
          setFocusIndex((i) => (i > 0 ? i - 1 : i));
          break;
        case "Enter": {
          e.preventDefault();
          if (focusIndex >= 0 && focusIndex < THEME_OPTIONS.length) {
            onSelectTheme(THEME_OPTIONS[focusIndex].id);
          }
          break;
        }
        case "Escape":
          e.preventDefault();
          setOpen(false);
          break;
      }
    },
    [open, focusIndex, onSelectTheme],
  );

  return (
    <div ref={ref} className="relative inline-block" onKeyDown={handleKeyDown}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(!open)}
        title="Change theme"
        aria-label="Change theme"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <PaletteIcon size={ICON_SIZE.SM} />
      </Button>

      {open && (
        <div
          role="listbox"
          aria-label="Theme options"
          className="absolute right-0 top-full mt-1 w-80 max-h-[80vh] overflow-y-auto bg-(--color-bg-elevated) border border-(--color-border-primary) rounded-lg shadow-lg z-50 p-2 grid grid-cols-2 gap-1.5"
        >
          {THEME_OPTIONS.map((opt, i) => {
            const [bg, text, accent, secondary] =
              PREVIEW[opt.id] ?? FALLBACK;
            const isActive = theme === opt.id;
            return (
              <button
                key={opt.id}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                role="option"
                aria-selected={isActive}
                onClick={() => onSelectTheme(opt.id)}
                className={`relative rounded-md p-2.5 text-left transition-shadow${i === focusIndex ? " ring-2 ring-(--color-border-focus)" : ""}${isActive ? " ring-2 ring-(--color-accent)" : ""}`}
                style={{ backgroundColor: bg }}
              >
                <span
                  className="block text-[11px] font-semibold leading-tight"
                  style={{ color: accent }}
                >
                  {opt.label}
                </span>
                <span
                  className="block text-[10px] leading-tight mt-0.5"
                  style={{ color: secondary }}
                >
                  {opt.description}
                </span>
                {isActive && (
                  <CheckIcon
                    size={12}
                    weight="bold"
                    className="absolute top-1.5 right-1.5"
                    style={{ color: accent }}
                  />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
