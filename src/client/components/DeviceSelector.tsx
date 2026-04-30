import { useState, useMemo } from "react";
import { CaretDownIcon, CheckIcon, DeviceMobileIcon, DeviceRotateIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu.js";
import { Button } from "./ui/button.js";
import { DEVICE_PRESETS, type DevicePreset } from "./device-presets.js";

export interface DeviceSelectorProps {
  /** Currently active preset, or null when "Responsive" (fill panel). */
  activePreset: DevicePreset | null;
  /** Whether the active preset is rotated to landscape. */
  isLandscape: boolean;
  /** Custom size, used when activePreset.category === "custom". */
  customSize: { width: number; height: number } | null;
  /** Called with a preset, or null to switch back to "Responsive". */
  onSelectPreset: (preset: DevicePreset | null) => void;
  /** Called when the user clicks the rotate button. */
  onToggleLandscape: () => void;
  /** Called with the entered width and height when a custom size is applied. */
  onCustomSize: (width: number, height: number) => void;
}

/**
 * Compact dropdown that lets the user pick a viewport size for the preview iframe.
 *
 * Default is "Responsive" (iframe fills the panel). Picking a named preset constrains
 * the iframe to phone or tablet dimensions and shows a rotate button. A custom width
 * and height can be entered at the bottom of the menu.
 */
export function DeviceSelector({
  activePreset,
  isLandscape,
  customSize,
  onSelectPreset,
  onToggleLandscape,
  onCustomSize,
}: DeviceSelectorProps) {
  const [open, setOpen] = useState(false);
  const [customWidthInput, setCustomWidthInput] = useState<string>(
    String(customSize?.width ?? 390),
  );
  const [customHeightInput, setCustomHeightInput] = useState<string>(
    String(customSize?.height ?? 844),
  );

  const phones = useMemo(() => DEVICE_PRESETS.filter((p) => p.category === "phone"), []);
  const tablets = useMemo(() => DEVICE_PRESETS.filter((p) => p.category === "tablet"), []);

  const triggerLabel = activePreset
    ? activePreset.label
    : "Responsive";

  const submitCustom = () => {
    const w = Math.round(Number(customWidthInput));
    const h = Math.round(Number(customHeightInput));
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      onCustomSize(w, h);
      setOpen(false);
    }
  };

  return (
    <span className="flex items-center gap-1">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            className="flex items-center gap-1.5 text-(--color-text-primary) hover:text-(--color-text-secondary) transition-colors cursor-pointer"
            aria-label="Select device viewport"
            title="Select device viewport"
          >
            <DeviceMobileIcon size={ICON_SIZE.SM} />
            <span>{triggerLabel}</span>
            <CaretDownIcon size={ICON_SIZE.XS} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-56">
          <DropdownMenuItem
            onSelect={() => onSelectPreset(null)}
            className={!activePreset ? "text-(--color-text-primary) bg-(--color-bg-hover)" : ""}
          >
            <span className="flex-1">Responsive</span>
            {!activePreset && <CheckIcon size={ICON_SIZE.XS} className="text-(--color-success)" />}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Phones</DropdownMenuLabel>
          {phones.map((preset) => {
            const isActive = activePreset?.id === preset.id;
            return (
              <DropdownMenuItem
                key={preset.id}
                onSelect={() => onSelectPreset(preset)}
                className={isActive ? "text-(--color-text-primary) bg-(--color-bg-hover)" : ""}
              >
                <span className="flex-1">{preset.label}</span>
                <span className="text-(--color-text-tertiary) tabular-nums text-[10px]">
                  {preset.width}×{preset.height}
                </span>
                {isActive && <CheckIcon size={ICON_SIZE.XS} className="text-(--color-success)" />}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Tablets</DropdownMenuLabel>
          {tablets.map((preset) => {
            const isActive = activePreset?.id === preset.id;
            return (
              <DropdownMenuItem
                key={preset.id}
                onSelect={() => onSelectPreset(preset)}
                className={isActive ? "text-(--color-text-primary) bg-(--color-bg-hover)" : ""}
              >
                <span className="flex-1">{preset.label}</span>
                <span className="text-(--color-text-tertiary) tabular-nums text-[10px]">
                  {preset.width}×{preset.height}
                </span>
                {isActive && <CheckIcon size={ICON_SIZE.XS} className="text-(--color-success)" />}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Custom</DropdownMenuLabel>
          <div
            className="px-3 py-2 flex items-center gap-1.5"
            // Prevent dropdown from closing when interacting with the inputs
            onKeyDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <input
              type="number"
              min={1}
              aria-label="Custom width"
              value={customWidthInput}
              onChange={(e) => setCustomWidthInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitCustom();
                }
              }}
              className="w-16 px-1.5 py-0.5 rounded bg-(--color-bg-secondary) border border-(--color-border-secondary) text-xs text-(--color-text-primary) tabular-nums focus:outline-none focus:border-(--color-accent)"
            />
            <span className="text-(--color-text-tertiary) text-xs">×</span>
            <input
              type="number"
              min={1}
              aria-label="Custom height"
              value={customHeightInput}
              onChange={(e) => setCustomHeightInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitCustom();
                }
              }}
              className="w-16 px-1.5 py-0.5 rounded bg-(--color-bg-secondary) border border-(--color-border-secondary) text-xs text-(--color-text-primary) tabular-nums focus:outline-none focus:border-(--color-accent)"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={submitCustom}
              title="Apply custom size"
            >
              Apply
            </Button>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      {activePreset && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleLandscape}
          title={isLandscape ? "Switch to portrait" : "Switch to landscape"}
          aria-label={isLandscape ? "Switch to portrait" : "Switch to landscape"}
          aria-pressed={isLandscape}
        >
          <DeviceRotateIcon size={ICON_SIZE.SM} />
        </Button>
      )}
    </span>
  );
}
