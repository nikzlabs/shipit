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
  /** Called with a preset, or null to switch back to "Responsive". */
  onSelectPreset: (preset: DevicePreset | null) => void;
  /** Called when the user clicks the rotate button. */
  onToggleLandscape: () => void;
  /** Called with the entered width and height when a custom size is applied. */
  onCustomSize: (width: number, height: number) => void;
}

/**
 * The custom-size inputs, mounted as a child of `DropdownMenuContent`.
 *
 * Being a child is the whole point: Radix unmounts the content on close, so a
 * child that seeds its state from the current `customSize` on mount re-prefills
 * on every open. The original inline `useState` sat on `DeviceSelector` itself
 * and kept the previous values, so a size applied elsewhere (or a session
 * switch restoring a snapshot) showed stale numbers on the next open.
 */
function CustomSizeInputs({
  initialSize,
  onApply,
}: {
  initialSize: { width: number; height: number } | null;
  onApply: (width: number, height: number) => void;
}) {
  const [widthInput, setWidthInput] = useState<string>(String(initialSize?.width ?? 390));
  const [heightInput, setHeightInput] = useState<string>(String(initialSize?.height ?? 844));

  const parsedWidth = Math.round(Number(widthInput));
  const parsedHeight = Math.round(Number(heightInput));
  const widthValid =
    Number.isFinite(parsedWidth) && parsedWidth >= CUSTOM_SIZE_MIN && parsedWidth <= CUSTOM_SIZE_MAX;
  const heightValid =
    Number.isFinite(parsedHeight) && parsedHeight >= CUSTOM_SIZE_MIN && parsedHeight <= CUSTOM_SIZE_MAX;
  const customValid = widthValid && heightValid;

  const submitCustom = () => {
    if (customValid) {
      onApply(parsedWidth, parsedHeight);
    }
  };

  return (
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
          value={widthInput}
          onChange={(e) => setWidthInput(e.target.value)}
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
          value={heightInput}
          onChange={(e) => setHeightInput(e.target.value)}
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
  );
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

  const phones = useMemo(() => DEVICE_PRESETS.filter((p) => p.category === "phone"), []);
  const tablets = useMemo(() => DEVICE_PRESETS.filter((p) => p.category === "tablet"), []);

  // A rotated custom size reports its applied (portrait) dimensions in
  // `activePreset.label`; the on-screen frame is swapped, so the trigger must
  // show the swapped pair.
  const triggerLabel =
    activePreset?.category === "custom" && customSize && isLandscape
      ? `${customSize.height}×${customSize.width}`
      : activePreset
        ? activePreset.label
        : "Responsive";

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
          <CustomSizeInputs
            initialSize={customSize}
            onApply={(width, height) => {
              onCustomSize(width, height);
              setOpen(false);
            }}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      {activePreset && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
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
