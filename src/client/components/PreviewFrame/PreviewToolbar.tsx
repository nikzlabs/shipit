import { ArrowClockwiseIcon, ArrowSquareOutIcon, CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../ui/dropdown-menu.js";
import { Button } from "../ui/button.js";
import { StatusDot } from "../ui/status-dot.js";
import { DeviceSelector } from "../DeviceSelector.js";
import { usePreviewStore } from "../../stores/preview-store.js";

/** One selectable port row in the port dropdown. */
export interface PortInfo {
  port: number;
  label: string;
  status: "running" | "starting" | "error" | "stopped";
}

function statusToDotVariant(status: string): "success" | "warning" | "error" | "info" {
  switch (status) {
    case "running": return "success";
    case "starting": return "warning";
    case "error": return "error";
    default: return "info";
  }
}

interface PreviewToolbarProps {
  isRunning: boolean;
  /** Whether to render the port dropdown vs. a plain port label. */
  showSelector: boolean;
  portSelectorOpen: boolean;
  setPortSelectorOpen: (open: boolean) => void;
  /** Status of the active port, used for the leading status dot. */
  activeStatus: string;
  /** Display label for the active port (e.g. "localhost:5173" or a service name). */
  portLabel: string | null;
  /** All selectable ports for the dropdown. */
  allPorts: PortInfo[];
  activePort: number;
  onSelectPort: (port: number) => void;
  // Device-frame metrics (computed by useDeviceFrame in the parent).
  deviceFrameActive: boolean;
  deviceWidth: number;
  deviceHeight: number;
  deviceScale: number;
  deviceScalePercent: number;
  // Error badge.
  hasErrors: boolean;
  errorCount: number;
  errorPanelOpen: boolean;
  setErrorPanelOpen: (fn: (prev: boolean) => boolean) => void;
  /** Force-reload the active iframe. */
  onRefresh: () => void;
  /** URL of the active iframe slot, or null when none is mounted. */
  activeSlotUrl: string | null;
}

/**
 * Top bar of the preview pane: port selector, device viewport controls, the
 * error badge, the auto-fix toggle, and refresh / open-in-new-tab actions.
 *
 * Device-viewport and auto-fix UI state are read directly from `preview-store`
 * (same as before the split); port/error/refresh concerns arrive as props.
 */
export function PreviewToolbar({
  isRunning,
  showSelector,
  portSelectorOpen,
  setPortSelectorOpen,
  activeStatus,
  portLabel,
  allPorts,
  activePort,
  onSelectPort,
  deviceFrameActive,
  deviceWidth,
  deviceHeight,
  deviceScale,
  deviceScalePercent,
  hasErrors,
  errorCount,
  errorPanelOpen,
  setErrorPanelOpen,
  onRefresh,
  activeSlotUrl,
}: PreviewToolbarProps) {
  const autoFixEnabled = usePreviewStore((s) => s.autoFixEnabled);
  const autoFixRetries = usePreviewStore((s) => s.autoFixRetries);
  const onToggleAutoFix = usePreviewStore((s) => s.toggleAutoFix);
  const devicePreset = usePreviewStore((s) => s.devicePreset);
  const isLandscape = usePreviewStore((s) => s.isLandscape);
  const customSize = usePreviewStore((s) => s.customSize);
  const setDevicePreset = usePreviewStore((s) => s.setDevicePreset);
  const toggleLandscape = usePreviewStore((s) => s.toggleLandscape);
  const setCustomSize = usePreviewStore((s) => s.setCustomSize);

  return (
    <div className="flex items-center justify-between px-3 py-1.5 bg-(--color-bg-secondary) border-b border-(--color-border-secondary) text-xs text-(--color-text-secondary)">
      <span className="flex items-center gap-2">
        {showSelector ? (
          <DropdownMenu open={portSelectorOpen} onOpenChange={setPortSelectorOpen}>
            <DropdownMenuTrigger asChild>
              <button
                className="flex items-center gap-1.5 text-(--color-text-primary) hover:text-(--color-text-secondary) transition-colors cursor-pointer"
                aria-label="Select preview port"
              >
                <StatusDot status={statusToDotVariant(activeStatus)} />
                <span>{portLabel}</span>
                <CaretDownIcon size={ICON_SIZE.XS} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-35">
              {allPorts.map((item) => {
                const isActive = item.port === activePort;
                return (
                  <DropdownMenuItem
                    key={item.port}
                    onSelect={() => onSelectPort(item.port)}
                    className={`text-xs ${
                      isActive
                        ? "text-(--color-text-primary) bg-(--color-bg-hover)"
                        : "text-(--color-text-secondary)"
                    }`}
                  >
                    <StatusDot status={statusToDotVariant(item.status)} />
                    <span className="flex-1">{item.label}</span>
                    {isActive && <CheckIcon size={ICON_SIZE.XS} className="text-(--color-success)" />}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <>
            <StatusDot status={isRunning || portLabel ? "success" : "info"} />
            {portLabel ? portLabel : <span className="text-(--color-text-tertiary)">Preview</span>}
          </>
        )}
        {isRunning && (
          <>
            <span className="text-(--color-border-secondary)">|</span>
            <DeviceSelector
              activePreset={devicePreset}
              isLandscape={isLandscape}
              customSize={customSize}
              onSelectPreset={(preset) => {
                setDevicePreset(preset);
                if (!preset) setCustomSize(null);
              }}
              onToggleLandscape={toggleLandscape}
              onCustomSize={(width, height) => {
                setCustomSize({ width, height });
                setDevicePreset({
                  id: "custom",
                  label: `${width}×${height}`,
                  width,
                  height,
                  category: "custom",
                });
              }}
            />
            {deviceFrameActive && (
              <span className="text-(--color-text-tertiary) tabular-nums">
                {deviceWidth}×{deviceHeight}
                {deviceScale < 1 && (
                  <span className="ml-1 text-(--color-text-tertiary)">({deviceScalePercent}%)</span>
                )}
              </span>
            )}
          </>
        )}
      </span>
      <div className="flex items-center gap-2">
        {hasErrors && (
          <button
            onClick={() => setErrorPanelOpen((prev) => !prev)}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-(--color-error-subtle) text-(--color-error) hover:bg-(--color-bg-hover) transition-colors"
            aria-label="Toggle error panel"
          >
            <span className="inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 text-[10px] font-semibold rounded-full bg-(--color-error) text-(--color-accent-text)">
              {errorCount > 99 ? "99+" : errorCount}
            </span>
            <span>{errorPanelOpen ? "Hide" : "Errors"}</span>
          </button>
        )}
        <label className="flex items-center gap-1 cursor-pointer select-none" title="Auto-fix: automatically send errors to the agent for fixing">
          <input
            type="checkbox"
            checked={autoFixEnabled}
            onChange={onToggleAutoFix}
            className="sr-only peer"
          />
          <span className={`relative w-7 h-4 rounded-full transition-colors ${autoFixEnabled ? "bg-(--color-autofix)" : "bg-(--color-border-secondary)"}`}>
            <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${autoFixEnabled ? "translate-x-3" : ""}`} />
          </span>
          <span className={autoFixEnabled ? "text-(--color-autofix)" : ""}>
            Auto-fix{autoFixEnabled && autoFixRetries > 0 ? ` (${autoFixRetries}/3)` : ""}
          </span>
        </label>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          title="Refresh preview"
          className="h-7 w-7 p-0"
        >
          <ArrowClockwiseIcon size={ICON_SIZE.SM} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (activeSlotUrl) window.open(activeSlotUrl, "_blank", "noopener,noreferrer");
          }}
          title="Open preview in new tab"
          disabled={!activeSlotUrl}
          className="h-7 w-7 p-0"
        >
          <ArrowSquareOutIcon size={ICON_SIZE.SM} />
        </Button>
      </div>
    </div>
  );
}
