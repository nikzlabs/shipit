// eslint-disable-next-line no-restricted-imports -- useEffect: document mousedown listener for click-outside with cleanup (browser API subscription)
import { useState, useRef, useEffect, useCallback } from "react";
import { PaletteIcon, CheckIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { THEME_OPTIONS, type Theme } from "../hooks/useTheme.js";

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
          {THEME_OPTIONS.map((opt: { id: string; label: string; description: string }, i) => {
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
                className={`${opt.id} relative rounded-md p-2.5 text-left border bg-(--color-bg-primary) border-(--color-border-secondary) transition-shadow${i === focusIndex ? " ring-2 ring-(--color-border-focus)" : ""}${isActive ? " ring-2 ring-(--color-accent)" : ""}`}
              >
                <span className="block text-[11px] font-semibold leading-tight text-(--color-accent)">
                  {opt.label}
                </span>
                <span className="block text-[10px] leading-tight mt-0.5 text-(--color-text-secondary)">
                  {opt.description}
                </span>
                {isActive && (
                  <CheckIcon
                    size={12}
                    weight="bold"
                    className="absolute top-1.5 right-1.5 text-(--color-accent)"
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
