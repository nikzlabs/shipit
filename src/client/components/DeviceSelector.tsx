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
import {
  DEVICE_PRESETS,
  CUSTOM_SIZE_MIN,
  CUSTOM_SIZE_MAX,
  type DevicePreset,
} from "./device-presets.js";

export interface DeviceSelectorProps {
  /** Currently active preset, or null when "Responsive" (fill panel). */
  activePreset: DevicePreset | null;
  /** Whether the active preset is rotated to landscape. */
  isLandscape: boolean;
  /** Custom size, used when activePreset.category === "custom". */
  customSize: { width: number; height: number } | null;
  /**
   * What the panel can show at 100% scale, or null while unmeasured — the size
   * the Freeform row activates on first use, so the drag handles appear around
   * exactly what the user was looking at (docs/278).
   */
  panelSize: { width: number; height: number } | null;
  /** Called with a preset, or null to switch back to "Responsive". */
  onSelectPreset: (preset: DevicePreset | null) => void;
  /** Called when the user clicks the rotate button. */
  onToggleLandscape: () => void;
  /** Called with the width and height when a custom/freeform size is applied. */
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
  panelSize,
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

  const isCustomActive = activePreset?.category === "custom";
  // Last custom size wins; the panel's own size on first use; a phone-ish
  // fallback only while the panel is unmeasured.
  const freeformTarget = customSize ?? panelSize ?? { width: 390, height: 844 };

  const triggerLabel = activePreset
    ? activePreset.label
    : "Responsive";

  const parsedWidth = Math.round(Number(customWidthInput));
  const parsedHeight = Math.round(Number(customHeightInput));
  const widthValid =
    Number.isFinite(parsedWidth) && parsedWidth >= CUSTOM_SIZE_MIN && parsedWidth <= CUSTOM_SIZE_MAX;
  const heightValid =
    Number.isFinite(parsedHeight) && parsedHeight >= CUSTOM_SIZE_MIN && parsedHeight <= CUSTOM_SIZE_MAX;
  const customValid = widthValid && heightValid;

  const submitCustom = () => {
    if (customValid) {
      onCustomSize(parsedWidth, parsedHeight);
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
            // Names the active preset, not just the control: once the toolbar
            // collapses this label away, the tooltip is what reports it.
            title={`Select device viewport (${triggerLabel})`}
          >
            <DeviceMobileIcon size={ICON_SIZE.SM} />
            {/* First label the preview toolbar gives up when it runs short of
                width (see usePreviewToolbarCollapse): the device icon still
                carries the meaning, and the `title` keeps the exact preset
                readable. Inert anywhere without a `group/ptb` ancestor. */}
            <span className="group-data-[hide-viewport=true]/ptb:hidden">{triggerLabel}</span>
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
          {/* Freeform: activate a custom size and resize it by dragging the
              surface's edges. Enters at the last custom size, or at what the
              panel currently shows on first use, so the handles appear around
              exactly what the user was looking at (docs/278). */}
          <DropdownMenuItem
            onSelect={() => onCustomSize(freeformTarget.width, freeformTarget.height)}
            className={isCustomActive ? "text-(--color-text-primary) bg-(--color-bg-hover)" : ""}
          >
            <span className="flex-1">Freeform</span>
            <span className="text-(--color-text-tertiary) text-[10px]">drag edges to resize</span>
            {isCustomActive && <CheckIcon size={ICON_SIZE.XS} className="text-(--color-success)" />}
          </DropdownMenuItem>
          <div
            className="px-3 py-2 flex flex-col gap-1"
            // Prevent dropdown from closing when interacting with the inputs
            onKeyDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={CUSTOM_SIZE_MIN}
                max={CUSTOM_SIZE_MAX}
                aria-label="Custom width"
                aria-invalid={!widthValid}
                value={customWidthInput}
                onChange={(e) => setCustomWidthInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitCustom();
                  }
                }}
                className={`w-16 px-1.5 py-0.5 rounded bg-(--color-bg-secondary) border text-xs text-(--color-text-primary) tabular-nums focus:outline-none ${widthValid ? "border-(--color-border-secondary) focus:border-(--color-accent)" : "border-(--color-error) focus:border-(--color-error)"}`}
              />
              <span className="text-(--color-text-tertiary) text-xs">×</span>
              <input
                type="number"
                min={CUSTOM_SIZE_MIN}
                max={CUSTOM_SIZE_MAX}
                aria-label="Custom height"
                aria-invalid={!heightValid}
                value={customHeightInput}
                onChange={(e) => setCustomHeightInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitCustom();
                  }
                }}
                className={`w-16 px-1.5 py-0.5 rounded bg-(--color-bg-secondary) border text-xs text-(--color-text-primary) tabular-nums focus:outline-none ${heightValid ? "border-(--color-border-secondary) focus:border-(--color-accent)" : "border-(--color-error) focus:border-(--color-error)"}`}
              />
              <Button
                variant="secondary"
                size="md"
                onClick={submitCustom}
                disabled={!customValid}
                title={customValid ? "Apply custom size" : `Width and height must be between ${CUSTOM_SIZE_MIN} and ${CUSTOM_SIZE_MAX}`}
              >
                Apply
              </Button>
            </div>
            {!customValid && (
              <span className="text-[10px] text-(--color-error)">
                Must be {CUSTOM_SIZE_MIN}–{CUSTOM_SIZE_MAX} px
              </span>
            )}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      {activePreset && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={onToggleLandscape}
          // A custom size has no portrait/landscape identity — it is stored as
          // rendered and rotating just swaps the dims (docs/278) — so the
          // control is a plain action there, not a pressed/unpressed toggle.
          title={isCustomActive ? "Swap width and height" : isLandscape ? "Switch to portrait" : "Switch to landscape"}
          aria-label={isCustomActive ? "Swap width and height" : isLandscape ? "Switch to portrait" : "Switch to landscape"}
          {...(isCustomActive ? {} : { "aria-pressed": isLandscape })}
        >
          <DeviceRotateIcon size={ICON_SIZE.SM} />
        </Button>
      )}
    </span>
  );
}
