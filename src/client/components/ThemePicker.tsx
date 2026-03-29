import { useState, useRef, useCallback } from "react";
import { useClickOutside } from "../hooks/useClickOutside.js";
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

  const handleClose = useCallback(() => setOpen(false), []);
  useClickOutside(ref, handleClose, open);

  const scrollFocusedIntoView = useCallback((index: number) => {
    itemRefs.current[index]?.scrollIntoView({ block: "nearest" });
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!open) return;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setFocusIndex((i) => { const next = (i + 1) % THEME_OPTIONS.length; scrollFocusedIntoView(next); return next; });
          break;
        case "ArrowUp":
          e.preventDefault();
          setFocusIndex((i) => { const next = (i - 1 + THEME_OPTIONS.length) % THEME_OPTIONS.length; scrollFocusedIntoView(next); return next; });
          break;
        case "ArrowRight":
          e.preventDefault();
          setFocusIndex((i) => { const next = i + 1 < THEME_OPTIONS.length ? i + 1 : i; scrollFocusedIntoView(next); return next; });
          break;
        case "ArrowLeft":
          e.preventDefault();
          setFocusIndex((i) => { const next = i > 0 ? i - 1 : i; scrollFocusedIntoView(next); return next; });
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
    [open, focusIndex, onSelectTheme, scrollFocusedIntoView],
  );

  return (
    <div ref={ref} className="relative inline-block" onKeyDown={handleKeyDown}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          if (!open) {
            const activeIndex = THEME_OPTIONS.findIndex((o) => o.id === theme);
            setFocusIndex(activeIndex >= 0 ? activeIndex : 0);
          }
          setOpen(!open);
        }}
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
