import { useRef } from "react";
import { PaletteIcon, CheckIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { THEME_OPTIONS, type Theme } from "../hooks/useTheme.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from "./ui/dropdown-menu.js";

interface ThemePickerProps {
  theme: Theme;
  onSelectTheme: (theme: Theme) => void;
}

export function ThemePicker({ theme, onSelectTheme }: ThemePickerProps) {
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          title="Change theme"
          aria-label="Change theme"
        >
          <PaletteIcon size={ICON_SIZE.SM} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-80 max-h-[80vh] overflow-y-auto p-2 grid grid-cols-2 gap-1.5"
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
              className={`${opt.id} relative rounded-md p-2.5 text-left border bg-(--color-bg-primary) border-(--color-border-secondary) transition-shadow focus:ring-2 focus:ring-(--color-border-focus) outline-none${isActive ? " ring-2 ring-(--color-accent)" : ""}`}
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
