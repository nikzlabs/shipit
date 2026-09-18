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
  activePreset: DevicePreset | null;
  isLandscape: boolean;
  customSize: { width: number; height: number } | null;
  /** Available size at 100% scale; null before measurement. */
  panelSize: { width: number; height: number } | null;
  onSelectPreset: (preset: DevicePreset | null) => void;
  onToggleLandscape: () => void;
  onCustomSize: (width: number, height: number) => void;
}

function CustomSizeInputs({
  initialSize,
  onApply,
}: {
  initialSize: { width: number; height: number };
  onApply: (width: number, height: number) => void;
}) {
  const [widthInput, setWidthInput] = useState<string>(String(initialSize.width));
  const [heightInput, setHeightInput] = useState<string>(String(initialSize.height));

  const parsedWidth = Math.round(Number(widthInput));
  const parsedHeight = Math.round(Number(heightInput));
  const widthValid =
    Number.isFinite(parsedWidth) && parsedWidth >= CUSTOM_SIZE_MIN && parsedWidth <= CUSTOM_SIZE_MAX;
  const heightValid =
    Number.isFinite(parsedHeight) && parsedHeight >= CUSTOM_SIZE_MIN && parsedHeight <= CUSTOM_SIZE_MAX;
  const customValid = widthValid && heightValid;

  const submitCustom = () => {
    if (customValid) onApply(parsedWidth, parsedHeight);
  };

  return (
    <div
      className="px-3 py-2 flex flex-col gap-1"
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
  // Force fresh input values even if reopening interrupts Radix's exit animation.
  const [openCount, setOpenCount] = useState(0);

  const phones = useMemo(() => DEVICE_PRESETS.filter((p) => p.category === "phone"), []);
  const tablets = useMemo(() => DEVICE_PRESETS.filter((p) => p.category === "tablet"), []);

  const isCustomActive = activePreset?.category === "custom";
  const freeformTarget = customSize ?? panelSize ?? { width: 390, height: 844 };
  const inputSeed =
    customSize ??
    (activePreset
      ? isLandscape
        ? { width: activePreset.height, height: activePreset.width }
        : { width: activePreset.width, height: activePreset.height }
      : freeformTarget);

  const triggerLabel = activePreset
    ? activePreset.label
    : "Responsive";

  return (
    <span className="flex items-center gap-1">
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setOpenCount((c) => c + 1);
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            className="flex items-center gap-1.5 text-(--color-text-primary) hover:text-(--color-text-secondary) transition-colors cursor-pointer"
            aria-label="Select device viewport"
            title={`Select device viewport (${triggerLabel})`}
          >
            <DeviceMobileIcon size={ICON_SIZE.SM} />
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
          <DropdownMenuItem
            onSelect={() => onCustomSize(freeformTarget.width, freeformTarget.height)}
            className={isCustomActive ? "text-(--color-text-primary) bg-(--color-bg-hover)" : ""}
          >
            <span className="flex-1">Freeform</span>
            <span className="text-(--color-text-tertiary) text-[10px]">drag edges to resize</span>
            {isCustomActive && <CheckIcon size={ICON_SIZE.XS} className="text-(--color-success)" />}
          </DropdownMenuItem>
          <CustomSizeInputs
            key={openCount}
            initialSize={inputSeed}
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
